import { Hono, type Context } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { mapCities } from '../config/map-cities'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { TDX_ACCESS_TOKEN_REJECTED_CODE, TDX_ACCESS_TOKEN_REJECTED_MESSAGE } from '../domain/tdx-api-error'
import { selectBestEta } from '../domain/map/eta'
import { buildRouteTimetable } from '../domain/map/timetable'
import {
  realtimeJourneyEstimate,
  scheduledJourneyEstimates,
  type JourneyEstimate,
} from '../domain/map/journey-estimate'
import { includeFocusedCandidate, selectRealtimeCandidates } from '../domain/map/arrival-ranking'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem, type ScheduleQuery } from '../domain/schedule'
import { getRouteMapVariants } from '../infrastructure/tdx/map'
import {
  buildStopArrivalBatches,
  isStopArrivalBatchPayload,
  STOP_ARRIVAL_MAX_RESPONSE_BYTES,
} from '../infrastructure/tdx/stop-arrivals'
import {
  findNearbyStopPlaces,
  getCityNetwork,
  getActiveSnapshotVersion,
  getDirectRoutes,
  getJourneyLegStopRefs,
  getOneTransferRoutes,
  getSnapshotRouteVariants,
  getSnapshotRouteCatalog,
  getSnapshotSchedule,
  getStopPlace,
  getStopPlaceByStopUid,
  getStopPlaceBundle,
  getStopPlaceRoutes,
  searchStopPlaces,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import { fetchTDXJson, formatETALabel, getBusSchedule, getRouteCatalog, isRejectedUserTdxToken, isTDXRecordArray, resolveTDXJson, TDXServiceError, tdxCredentialScope, tdxRouteScope, tdxWarningFromError, withTDXBackgroundTasks, withUserTDXAccessToken, type BusETAItem, type TDXEnv, type TDXWarning } from '../lib/tdx'
import {
  ApiInputError,
  apiInputErrorBody,
  JOURNEY_ETA_BODY_LIMIT_BYTES,
  optionalQueryString,
  parseCoordinate,
  parseJourneyEtaInput,
  parseOptionalDirection,
  parseRadius,
  parseTdxAccessToken,
  readJsonBody,
  requiredQueryString,
} from '../lib/api-input'
import { memoryCacheGet, memoryCacheSet } from '../lib/memory-cache'
import { cacheMatchFailOpen, cachePutFailOpen } from '../lib/edge-cache'
import { beginApiOperationTelemetry, type ApiOperationTracker } from '../observability/api-operation'
import {
  journeyEtaOutcome,
  mapOperationErrorOutcome,
  mapRoutesOutcome,
  placeArrivalsOutcome,
  vehiclesOutcome,
} from '../observability/map-api-outcomes'
import { releaseIdentity } from '../observability/release-identity'
import type { TelemetryCity, TelemetryFailureClass, TelemetryOperation } from '../observability/telemetry'
import { renderMapPage } from '../map-page'

type Env = {
  Bindings: TDXEnv & TransitBindings & Pick<CloudflareBindings, 'CF_VERSION_METADATA'>
}
const map = new Hono<Env>()

// 瀏覽器直接向 TDX 換 token；Worker 只接收短效 token，永遠不接觸 Client Secret。
const tdxEnv = (c: Context<Env>) => {
  const env = withUserTDXAccessToken(c.env, parseTdxAccessToken(c.req.header('Authorization')))
  try {
    const executionCtx = c.executionCtx
    return withTDXBackgroundTasks(env, (promise) => executionCtx.waitUntil(promise))
  } catch {
    return env
  }
}

const REALTIME_COOLDOWN_SECONDS = 60
const LAST_REALTIME_SECONDS = 120

function strongerTDXWarning(current: TDXWarning | undefined, next: TDXWarning | undefined): TDXWarning | undefined {
  const priority: Record<TDXWarning, number> = {
    'tdx-unavailable': 1,
    'tdx-rate-limit': 2,
    'tdx-quota': 3,
  }
  if (!next || (current && priority[current] >= priority[next])) return current
  return next
}

function arrivalCacheKey(kind: 'cooldown' | 'last', city: string, suffix = ''): Request {
  return new Request(`https://mochi-cache.invalid/arrivals/${kind}/${encodeURIComponent(city)}/${encodeURIComponent(suffix)}`)
}

function routeEtaUrl(city: string, routeName: string, routeUid?: string): URL {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return url
}

function edgeCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default
}

// 記憶體層在前、Cache API 在後:Cache API 在 workers.dev 上是 no-op、
// 自訂網域上也只限同機房,單靠它冷卻旗標常常寫了就不見。
async function hasRealtimeCooldown(env: TDXEnv, city: string, scope: string): Promise<boolean> {
  if (memoryCacheGet<boolean>(`arrivals/cooldown/${city}/${scope}`)) return true
  return Boolean(await cacheMatchFailOpen(edgeCache(), arrivalCacheKey('cooldown', city, scope), 'arrivals_cooldown'))
}

async function setRealtimeCooldown(env: TDXEnv, city: string, scope: string): Promise<void> {
  memoryCacheSet(`arrivals/cooldown/${city}/${scope}`, true, REALTIME_COOLDOWN_SECONDS)
  await cachePutFailOpen(edgeCache(), arrivalCacheKey('cooldown', city, scope), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${REALTIME_COOLDOWN_SECONDS}` },
  }), 'arrivals_cooldown', env.TDX_BACKGROUND_TASKS)
}

type LastRealtime = { items: BusETAItem[]; cachedAt?: number }

async function readLastRealtime(env: TDXEnv, city: string, cacheKey: string): Promise<LastRealtime | undefined> {
  const memoized = memoryCacheGet<LastRealtime>(`arrivals/last/${city}/${cacheKey}`)
  if (memoized) return memoized
  const response = await cacheMatchFailOpen(edgeCache(), arrivalCacheKey('last', city, cacheKey), 'arrivals_last')
  if (!response) return undefined
  try {
    const items = await response.json<BusETAItem[]>()
    if (!Array.isArray(items)) return undefined
    const headerValue = response.headers.get('X-Mochi-Cached-At')
    const header = headerValue === null ? Number.NaN : Number(headerValue)
    return { items, ...(Number.isFinite(header) && header >= 0 ? { cachedAt: header } : {}) }
  } catch (error) {
    console.error(JSON.stringify({
      message: 'edge_cache_payload_invalid',
      context: 'arrivals_last',
      error: error instanceof Error ? error.message : String(error),
    }))
    return undefined
  }
}

async function writeLastRealtime(env: TDXEnv, city: string, cacheKey: string, items: BusETAItem[]): Promise<void> {
  const cachedAt = Date.now()
  memoryCacheSet(`arrivals/last/${city}/${cacheKey}`, { items, cachedAt }, LAST_REALTIME_SECONDS)
  await cachePutFailOpen(edgeCache(), arrivalCacheKey('last', city, cacheKey), new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LAST_REALTIME_SECONDS}`,
      'X-Mochi-Cached-At': String(cachedAt),
    },
  }), 'arrivals_last', env.TDX_BACKGROUND_TASKS)
}

function routeIdentity(routeName: string, routeUid?: string): string {
  return routeUid ? `uid:${routeUid}` : `name:${routeName}`
}

function telemetryCity(value: string | undefined): TelemetryCity | null {
  return value && supportedCityCodes.has(value) ? value as TelemetryCity : null
}

function beginMapOperation(
  c: Context<Env>,
  operation: TelemetryOperation,
  city: TelemetryCity | null,
): ApiOperationTracker {
  return beginApiOperationTelemetry({
    operation,
    city,
    trafficClass: 'user',
    releaseIdentity: releaseIdentity(c.env?.CF_VERSION_METADATA),
  })
}

function mapFailureClass(error: unknown, authorization?: string): TelemetryFailureClass {
  if (error instanceof QueryValidationError || error instanceof ApiInputError) return 'input_validation'
  if (isRejectedUserTdxToken(error, authorization)) return 'tdx_401'
  if (!(error instanceof TDXServiceError)) return 'unknown'
  if (error.status === 401) return 'tdx_401'
  if (error.warning === 'tdx-quota') return 'tdx_quota'
  if (error.status === 429 || error.warning === 'tdx-rate-limit') return 'tdx_429'
  if (error.status !== undefined && error.status >= 500) return 'tdx_5xx'
  const causeName = error.cause instanceof Error ? error.cause.name : ''
  if (causeName === 'AbortError' || causeName === 'TimeoutError') return 'tdx_timeout'
  return error.status === undefined ? 'network' : 'unknown'
}

function completeMapError(
  c: Context<Env>,
  tracker: ApiOperationTracker,
  error: unknown,
  fallback: string,
  city?: TelemetryCity | null,
) {
  const response = mapJsonError(c, error, fallback)
  tracker.complete({
    ...mapOperationErrorOutcome(mapFailureClass(error, c.req.header('Authorization'))),
    httpStatus: response.status,
    ...(city === undefined ? {} : { city }),
  })
  return response
}

map.get('/map', (c) => {
  // 深連結的標題直接從 query 組(路線名就在網址裡,不用查庫);
  // place 深連結要查 DB 才有名字,不值得為標題多一次往返,維持通用標題。
  const routeName = c.req.query('route')?.trim()
  const cityName = mapCities.find((city) => city.code === c.req.query('city')?.trim())?.name
  const meta = routeName && routeName.length <= 40
    ? { title: `${routeName} 公車路線圖｜Mochi Bus`, description: `${routeName} 的路線走向、站牌與即時到站`, heading: `${routeName} 公車路線圖` }
    : cityName
      ? { title: `${cityName}公車地圖｜Mochi Bus`, description: `${cityName}的公車路網、附近站牌與路線規劃`, heading: `${cityName}公車地圖` }
      : {}
  return c.html(renderMapPage({ ...meta, requestUrl: c.req.url }), 200, {
    'Cache-Control': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
  })
})

map.get('/api/v1/map/cities', (c) => c.json({ schemaVersion: 1, cities: mapCities }, 200, {
  'Cache-Control': 'public, max-age=86400',
}))

map.get('/api/v1/map/locate', (c) => {
  // Cloudflare 依連線 IP 推估的粗略位置(縣市級),不經過瀏覽器定位、不會跳授權框;
  // 誤差可達數公里,只夠拿來挑縣市,不能拿來找站牌。
  const cf = (c.req.raw as Request & { cf?: { latitude?: string; longitude?: string } }).cf
  const latitude = Number(cf?.latitude)
  const longitude = Number(cf?.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return c.json({ error: '這次的連線判斷不出位置' }, 404)
  }
  return c.json({ latitude, longitude }, 200, { 'Cache-Control': 'no-store' })
})

map.get('/api/v1/map/routes', async (c) => {
  const tracker = beginMapOperation(c, 'map_routes', telemetryCity(c.req.query('city')?.trim()))
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    const snapshotVersion = snapshotRoutes.length ? await getActiveSnapshotVersion(c.env, city) : null
    const response = c.json({
      schemaVersion: 2,
      city,
      source: snapshotRoutes.length ? 'snapshot' : 'tdx',
      snapshotVersion,
      routes,
    }, 200, {
      'Cache-Control': `public, max-age=${snapshotRoutes.length ? 86400 : 300}`,
    })
    tracker.complete({
      ...mapRoutesOutcome({
        snapshotRouteCount: snapshotRoutes.length,
        routeCount: routes.length,
        snapshotVersion,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '路線目錄讀取失敗')
  }
})

map.get('/api/v1/map/route', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇有效縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('請選擇有效路線')

    const snapshotVariants = await getSnapshotRouteVariants(c.env, city, routeName)
    const variants = snapshotVariants.length
      ? snapshotVariants
      : await getRouteMapVariants(tdxEnv(c), city, routeName)
    if (!variants.length) {
      return c.json({ error: '這條路線目前沒有可用的地圖線型' }, 404)
    }
    return c.json({ schemaVersion: 1, city, routeName, source: snapshotVariants.length ? 'snapshot' : 'tdx', variants }, 200, {
      'Cache-Control': `public, max-age=${snapshotVariants.length ? 86400 : 300}`,
    })
  } catch (error) {
    if (!(error instanceof QueryValidationError || error instanceof ApiInputError)) {
      console.error('route_map_failed', error)
    }
    return mapJsonError(c, error, '暫時無法取得路線地圖')
  }
})

map.get('/api/v1/map/timetable', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
    const variantKey = optionalQueryString(c.req.query('variant'), '路線方向識別碼', 200)
    const subRouteUid = optionalQueryString(c.req.query('subRouteUid'), 'SubRouteUID', 100)
    const stopUid = optionalQueryString(c.req.query('stopUid'), 'StopUID', 100)
    const direction = parseOptionalDirection(c.req.query('direction'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇有效縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('請選擇有效路線')
    if (direction === undefined) throw new QueryValidationError('請選擇行駛方向')

    const snapshotVariants = await getSnapshotRouteVariants(c.env, city, routeName)
    const variants = snapshotVariants.length
      ? snapshotVariants
      : await getRouteMapVariants(tdxEnv(c), city, routeName)
    const variant = variants.find((candidate) =>
      candidate.direction === direction
      && (!variantKey || candidate.variantKey === variantKey)
      && (!routeUid || candidate.routeUid === routeUid)
      && (!subRouteUid || candidate.subRouteUid === subRouteUid))
    if (!variant) return c.json({ error: '找不到這個方向的站序' }, 404)

    const snapshotSchedules = await getSnapshotSchedule(c.env, city, routeName, variant.routeUid)
    const schedules = snapshotSchedules ?? await getBusSchedule(tdxEnv(c), city, routeName, variant.routeUid)
    const timetable = buildRouteTimetable(schedules, {
      direction: variant.direction,
      subRouteUid: variant.subRouteUid,
      stops: variant.stops.features.map((feature) => ({
        stopUid: feature.properties.stopUid,
        stopName: feature.properties.stopName,
        sequence: feature.properties.sequence,
      })),
    }, stopUid, new Date())
    return c.json({
      schemaVersion: 1,
      city,
      routeName,
      variantKey: variant.variantKey,
      routeUid: variant.routeUid,
      direction: variant.direction,
      source: snapshotSchedules ? 'snapshot' : 'tdx',
      timetable,
    }, 200, { 'Cache-Control': 'public, max-age=300' })
  } catch (error) {
    return mapJsonError(c, error, '時刻表讀取失敗')
  }
})

map.get('/api/v1/map/network', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const network = await getCityNetwork(c.env, city)
    if (!network) return c.json({ error: '這個縣市尚未建立全路網資料' }, 404)
    // R2 的 network.json 原樣串流,不在 Worker 內 parse+stringify(雙北 35MB+ 會撞
    // isolate 記憶體上限回 503)。前端只讀 routes/places,舊快照缺 schemaVersion/city 也無妨。
    if (network.kind === 'stream') {
      return new Response(network.body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'ETag': network.etag,
        },
      })
    }
    return c.json({ schemaVersion: 1, city, ...network.network }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '全路網讀取失敗')
  }
})

map.get('/api/v1/map/vehicles', async (c) => {
  const tracker = beginMapOperation(c, 'map_vehicles', telemetryCity(c.req.query('city')?.trim()))
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
    const direction = parseOptionalDirection(c.req.query('direction'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('路線格式錯誤')
    const url = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
    )
    url.searchParams.set('$format', 'JSON')
    let items: VehicleItem[] = []
    let warning: TDXWarning | undefined
    let upstreamSucceeded = false
    try {
      items = await fetchTDXJson<VehicleItem[]>(tdxEnv(c), url, 15, {
        operation: 'vehicle_positions',
        city: telemetryCity(city),
        validate: isTDXRecordArray<VehicleItem>,
      })
      upstreamSucceeded = true
    } catch (error) {
      if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
      warning = tdxWarningFromError(error) ?? 'tdx-unavailable'
      console.error(JSON.stringify({
        message: 'vehicle_position_upstream_failed', city, routeName,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    const identityMatchedItems = items
      .filter((item) => !routeUid || item.RouteUID === routeUid)
      .filter((item) => direction === undefined || item.Direction === direction)
    const vehicles = identityMatchedItems
      .filter((item) => Number.isFinite(item.BusPosition?.PositionLat) && Number.isFinite(item.BusPosition?.PositionLon))
      .map((item) => ({
        plate: item.PlateNumb ?? null,
        latitude: item.BusPosition!.PositionLat!,
        longitude: item.BusPosition!.PositionLon!,
        speed: item.Speed ?? null,
        azimuth: item.Azimuth ?? null,
        gpsTime: item.GPSTime ?? item.UpdateTime ?? null,
      }))
    const response = c.json({ schemaVersion: 1, city, routeName, vehicles, warning }, 200, {
      'Cache-Control': warning || c.req.header('Authorization') ? 'no-store' : 'public, max-age=15',
    })
    tracker.complete({
      ...vehiclesOutcome({
        upstreamSucceeded,
        rawCount: items.length,
        identityMatchedCount: identityMatchedItems.length,
        validVehicleCount: vehicles.length,
        warning,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '車輛位置讀取失敗')
  }
})

type VehicleItem = {
  PlateNumb?: string
  RouteUID?: string
  Direction?: number
  BusPosition?: { PositionLat?: number; PositionLon?: number }
  Speed?: number
  Azimuth?: number
  GPSTime?: string
  UpdateTime?: string
}

map.get('/api/v1/map/search', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const query = c.req.query('q')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!query || query.length > 40) throw new QueryValidationError('請輸入站牌名稱')
    const places = await searchStopPlaces(c.env, city, query)
    return c.json({ schemaVersion: 1, city, query, places }, 200, {
      'Cache-Control': 'public, max-age=3600',
    })
  } catch (error) {
    return mapJsonError(c, error, '站牌搜尋失敗')
  }
})

map.get('/api/v1/map/nearby', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const latitude = parseCoordinate(c.req.query('lat'), 'latitude')
    const longitude = parseCoordinate(c.req.query('lon'), 'longitude')
    const radius = parseRadius(c.req.query('radius'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const places = await findNearbyStopPlaces(c.env, city, latitude, longitude, radius)
    return c.json({ schemaVersion: 1, city, radius, places }, 200, { 'Cache-Control': 'public, max-age=300' })
  } catch (error) {
    return mapJsonError(c, error, '附近站牌查詢失敗')
  }
})

map.get('/api/v1/map/place/:placeId/routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const routes = await getStopPlaceRoutes(c.env, city, placeId)
    return c.json({ schemaVersion: 3, city, routes }, 200, { 'Cache-Control': 'public, max-age=86400' })
  } catch (error) {
    return mapJsonError(c, error, '站牌路線讀取失敗')
  }
})

map.get('/api/v1/map/place/:placeId/arrivals', async (c) => {
  const tracker = beginMapOperation(c, 'map_place_arrivals', telemetryCity(c.req.query('city')?.trim()))
  try {
    const env = tdxEnv(c)
    const scope = await tdxCredentialScope(env)
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const bundle = await getStopPlaceBundle(env, city, placeId)
    const now = new Date()
    const scheduledRoutes = bundle ? bundle.routes.map(({ schedules, ...route }) => ({
      ...route,
      ...scheduleFields(schedules, {
        stopUid: route.stopUid,
        direction: route.direction,
        subRouteUid: route.subRouteUid,
      }, now),
    })) : await (async () => {
      const routes = await getStopPlaceRoutes(env, city, placeId)
      const routeNames = [...new Set(routes.map((route) => route.routeName))]
      const schedulesByRoute = new Map((await Promise.all(routeNames.map(async (routeName) => [
        routeName,
        await getSnapshotSchedule(env, city, routeName) ?? [],
      ] as const))))
      return routes.map((route) => ({
        ...route,
        ...scheduleFields(schedulesByRoute.get(route.routeName) ?? [], {
          stopUid: route.stopUid,
          direction: route.direction,
          subRouteUid: route.subRouteUid,
        }, now),
      }))
    })()
    const focusStopUid = optionalQueryString(c.req.query('focusStopUid'), 'StopUID', 100)
    const focusSubRouteUid = optionalQueryString(c.req.query('focusSubRouteUid'), 'SubRouteUID', 100)
    const focusDirection = parseOptionalDirection(c.req.query('focusDirection'), 'focusDirection')
    const focused = focusStopUid ? scheduledRoutes.find((route) =>
      route.stopUid === focusStopUid
      && (focusDirection === undefined || route.direction === focusDirection)
      && (!focusSubRouteUid || route.subRouteUid === focusSubRouteUid),
    ) : undefined
    const candidates = includeFocusedCandidate(selectRealtimeCandidates(scheduledRoutes), focused)
    const batches = buildStopArrivalBatches(city, candidates.map((route) => ({
      routeUid: route.routeUid,
      routeName: route.routeName,
      stopUid: route.stopUid,
    })))
    const etaItems: BusETAItem[] = []
    const staleRouteIdentities = new Set<string>()
    let rateLimited = await hasRealtimeCooldown(env, city, scope)
    let warning: TDXWarning | undefined = rateLimited ? 'tdx-rate-limit' : undefined
    let realtimeQueries = 0
    for (const batch of batches) {
      try {
        const resolved = await resolveTDXJson<BusETAItem[]>(env, batch.url, 15, {
          operation: 'place_arrivals',
          city: telemetryCity(city),
          maxResponseBytes: STOP_ARRIVAL_MAX_RESPONSE_BYTES,
          validate: (value): value is BusETAItem[] => isStopArrivalBatchPayload(value, batch.stopUids),
          blockedFailureClass: rateLimited ? 'rate_limited' : undefined,
          staleFallback: async () => {
            const stale = await readLastRealtime(env, city, batch.cacheKey)
            return stale?.items.length ? {
              data: stale.items,
              dataAgeMilliseconds: stale.cachedAt === undefined ? undefined : Math.max(0, Date.now() - stale.cachedAt),
            } : undefined
          },
        })
        etaItems.push(...resolved.data)
        if (resolved.resolution === 'stale_replay') {
          batch.candidates.forEach((candidate) => {
            staleRouteIdentities.add(routeIdentity(candidate.routeName, candidate.routeUid))
          })
        } else {
          await writeLastRealtime(env, city, batch.cacheKey, resolved.data)
          realtimeQueries += 1
        }
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        rateLimited ||= error instanceof TDXServiceError && error.rateLimited
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'place_arrival_realtime_failed',
          city,
          tdxScope: batch.scope,
          stopUidCount: batch.stopUids.length,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (rateLimited) await setRealtimeCooldown(env, city, scope)
      }
    }
    const arrivals = scheduledRoutes.map((route) => {
      const realtime = selectBestEta(etaItems, route)
      const realtimeSeconds = typeof realtime?.EstimateTime === 'number' ? Math.max(0, realtime.EstimateTime) : null
      const estimateSeconds = realtimeSeconds ?? (route.scheduleMinutes === null ? null : route.scheduleMinutes * 60)
      const source = realtimeSeconds !== null
        ? staleRouteIdentities.has(routeIdentity(route.routeName, route.routeUid)) ? 'stale-realtime' as const : 'realtime' as const
        : route.scheduleMinutes !== null ? 'schedule' as const
          : 'none' as const
      return {
        ...route,
        estimateSeconds,
        etaLabel: source === 'realtime' || source === 'stale-realtime'
          ? formatETALabel(Math.ceil((realtimeSeconds as number) / 60), realtime?.StopStatus ?? 0)
          : source === 'schedule'
            ? route.scheduleClock
              ?? (route.scheduleHeadway
                ? `${route.scheduleHeadway[0]}–${route.scheduleHeadway[1]} 分一班`
                : route.scheduleDepartureBased
                  ? `${Math.max(1, route.scheduleMinutes ?? 1)} 分後發車`
                  : `約 ${Math.max(1, route.scheduleMinutes ?? 1)} 分`)
            : '暫無資訊',
        stopStatus: realtime?.StopStatus ?? 0,
        source,
      }
    }).sort((a, b) =>
      (a.estimateSeconds ?? Number.POSITIVE_INFINITY) - (b.estimateSeconds ?? Number.POSITIVE_INFINITY)
      || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }),
    )
    const response = c.json({
      schemaVersion: 1,
      city,
      routes: arrivals,
      scheduleSource: bundle ? 'place-bundle' : 'route-objects',
      snapshotVersion: bundle?.version ?? null,
      warning,
      realtime: { candidates: candidates.length, queries: realtimeQueries, rateLimited },
    }, 200, { 'Cache-Control': warning || c.req.header('Authorization') ? 'no-store' : 'public, max-age=15' })
    tracker.complete({
      ...placeArrivalsOutcome({
        bundleUsed: Boolean(bundle),
        sources: arrivals.map((arrival) => arrival.source),
        warning,
        snapshotVersion: bundle?.version ?? null,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '到站時間讀取失敗')
  }
})

map.get('/api/v1/map/place/:placeId', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = requiredQueryString(c.req.param('placeId'), '站牌識別碼', 100)
    const place = await getStopPlace(c.env, city, placeId)
    if (!place) return c.json({ error: '找不到這個站牌' }, 404)
    return c.json({ schemaVersion: 1, city, place }, 200, { 'Cache-Control': 'public, max-age=86400' })
  } catch (error) {
    return mapJsonError(c, error, '站牌資料讀取失敗')
  }
})

map.get('/api/v1/map/stop-place', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const stopUid = requiredQueryString(c.req.query('stopUid'), 'StopUID', 100)
    const place = await getStopPlaceByStopUid(c.env, city, stopUid)
    if (!place) return c.json({ error: '找不到這個站牌' }, 404)
    return c.json({ schemaVersion: 1, city, stopUid, place }, 200, { 'Cache-Control': 'public, max-age=3600' })
  } catch (error) {
    return mapJsonError(c, error, '站牌資料讀取失敗')
  }
})

map.get('/api/v1/map/direct', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const from = requiredQueryString(c.req.query('from'), '起點', 100)
    const to = requiredQueryString(c.req.query('to'), '終點', 100)
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const routes = await getDirectRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, routes }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '直達路線查詢失敗')
  }
})

map.get('/api/v1/map/transfer', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const from = requiredQueryString(c.req.query('from'), '出發位置', 100)
    const to = requiredQueryString(c.req.query('to'), '目的地', 100)
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const plans = await getOneTransferRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, plans }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '轉乘路線查詢失敗')
  }
})

map.post('/api/v1/map/journey-eta', bodyLimit({
  maxSize: JOURNEY_ETA_BODY_LIMIT_BYTES,
  onError: (c) => c.json({ error: '請求內容過大', code: 'PAYLOAD_TOO_LARGE' }, 413, {
    'Cache-Control': 'no-store',
  }),
}), async (c) => {
  const tracker = beginMapOperation(c, 'map_journey_eta', null)
  let observedCity: TelemetryCity | null = null
  try {
    const { city, legs } = parseJourneyEtaInput(await readJsonBody(c.req.raw), supportedCityCodes)
    observedCity = telemetryCity(city)
    const env = tdxEnv(c)
    let warning: TDXWarning | undefined

    const refs = await getJourneyLegStopRefs(env, city, legs)
    // 逐路線查 ETA(legs ≤ 12,去重後更少),與站牌到站查詢共用同一份快取。
    // 不抓整縣市:雙北的全城 ETA 一包可達數十 MB,快取只有幾秒,
    // 每次規劃都重抓一次,還會把 isolate 記憶體快取撐爆。
    const uniqueRouteRefs = [...new Map(refs.map((ref) => [ref.routeUid, ref])).values()]
    const etaItemsByRouteUid = new Map(await Promise.all(uniqueRouteRefs.map(async (ref) => {
      try {
        return [ref.routeUid, await fetchTDXJson<BusETAItem[]>(
          env,
          routeEtaUrl(city, ref.routeName, ref.routeUid),
          15,
          {
            operation: 'journey_eta',
            city: telemetryCity(city),
            validate: isTDXRecordArray<BusETAItem>,
          },
        )] as const
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'journey_eta_upstream_failed',
          city,
          routeName: ref.routeName,
          error: error instanceof Error ? error.message : String(error),
        }))
        return [ref.routeUid, [] as BusETAItem[]] as const
      }
    })))
    const realtimeEstimates = new Map<string, JourneyEstimate>(refs.map((ref) => {
      return [ref.key, realtimeJourneyEstimate(ref, etaItemsByRouteUid.get(ref.routeUid) ?? [])] as const
    }))

    const missingRefs = refs.filter((ref) => realtimeEstimates.get(ref.key)?.minutes === null)
    if (missingRefs.length) {
      try {
        const missingRouteRefs = [...new Map(missingRefs.map((ref) => [ref.routeUid, ref])).values()]
        const schedulesByRouteUid = new Map(await Promise.all(missingRouteRefs.map(async (ref) => {
          try {
            return [
              ref.routeUid,
              await getSnapshotSchedule(env, city, ref.routeName, ref.routeUid)
                ?? await getBusSchedule(env, city, ref.routeName, ref.routeUid),
            ] as const
          } catch (error) {
            if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
            warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
            console.error(JSON.stringify({
              message: 'journey_schedule_route_failed',
              city,
              routeUid: ref.routeUid,
              error: error instanceof Error ? error.message : String(error),
            }))
            return [ref.routeUid, [] as ScheduleItem[]] as const
          }
        })))
        const scheduled = scheduledJourneyEstimates(missingRefs, schedulesByRouteUid, new Date())
        scheduled.forEach((estimate, key) => realtimeEstimates.set(key, estimate))
      } catch (error) {
        if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) throw error
        warning = strongerTDXWarning(warning, tdxWarningFromError(error) ?? 'tdx-unavailable')
        console.error(JSON.stringify({
          message: 'journey_schedule_fallback_failed',
          city,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    const estimates = refs.map((ref) => realtimeEstimates.get(ref.key))
    const response = c.json({ schemaVersion: 1, city, fetchedAt: new Date().toISOString(), estimates, warning }, 200, {
      'Cache-Control': 'no-store',
    })
    tracker.complete({
      ...journeyEtaOutcome({ estimates, expectedCount: legs.length, warning }),
      httpStatus: 200,
      city: observedCity,
    })
    return response
  } catch (error) {
    if (!(error instanceof QueryValidationError || error instanceof ApiInputError)) {
      console.error(JSON.stringify({
        message: 'journey_eta_failed',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    return completeMapError(c, tracker, error, 'ETA 排序資料讀取失敗', observedCity)
  }
})

// 把 domain 的估計攤成回應欄位;departureBased/headway 只有伺服器端組 label 會用。
function scheduleFields(schedules: ScheduleItem[], query: ScheduleQuery, now: Date) {
  const estimate = nextScheduledMinutes(schedules, query, now)
  return {
    scheduleMinutes: estimate?.minutes ?? null,
    scheduleDepartureBased: estimate?.departureBased ?? false,
    scheduleHeadway: estimate?.headwayMinutes ?? null,
    scheduleClock: estimate ? scheduleClockLabel(estimate, now) : null,
  }
}

function mapJsonError(c: Context<Env>, error: unknown, fallback: string) {
  if (error instanceof ApiInputError) {
    return c.json(apiInputErrorBody(error), error.status, { 'Cache-Control': 'no-store' })
  }
  if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) {
    return c.json({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    }, 401, { 'Cache-Control': 'no-store' })
  }
  const isQueryError = error instanceof QueryValidationError
  return c.json({ error: isQueryError ? error.message : fallback }, isQueryError ? 400 : 502, {
    'Cache-Control': 'no-store',
  })
}

export default map
