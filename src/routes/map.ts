import { Hono, type Context } from 'hono'
import { mapCities } from '../config/map-cities'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { selectBestEta } from '../domain/map/eta'
import { includeFocusedCandidate, selectRealtimeCandidates } from '../domain/map/arrival-ranking'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem, type ScheduleQuery } from '../domain/schedule'
import { getRouteMapVariants } from '../infrastructure/tdx/map'
import {
  findNearbyStopPlaces,
  getCityNetwork,
  getDirectRoutes,
  getJourneyLegStopRefs,
  getOneTransferRoutes,
  getSnapshotRouteVariants,
  getSnapshotRouteCatalog,
  getSnapshotSchedule,
  getStopPlace,
  getStopPlaceBundle,
  getStopPlaceRoutes,
  searchStopPlaces,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import { fetchTDXJson, formatETALabel, getBusSchedule, getRouteCatalog, withUserTDX, type BusETAItem, type TDXEnv } from '../lib/tdx'
import { memoryCacheGet, memoryCacheSet } from '../lib/memory-cache'
import { renderMapPage } from '../map-page'

type Env = { Bindings: TDXEnv & TransitBindings }
const map = new Hono<Env>()

// API 請求可帶使用者自備的 TDX 憑證(setup 頁進階設定),即時查詢改用他的額度。
const tdxEnv = (c: Context<Env>) =>
  withUserTDX(c.env, c.req.header('x-tdx-client-id'), c.req.header('x-tdx-client-secret'))

// 429 冷卻以「縣市+憑證來源」為範圍:共用池在冷卻時,自備憑證的人不必連坐,
// 反過來他的 429 也不該冷卻到共用池。client_id 不是機密(secret 才是),當 key 沒問題。
const tdxScope = (env: TDXEnv) => env.TDX_USER_CLIENT_ID ?? 'shared'

const REALTIME_COOLDOWN_SECONDS = 60
const LAST_REALTIME_SECONDS = 120

function arrivalCacheKey(kind: 'cooldown' | 'last', city: string, suffix = ''): Request {
  return new Request(`https://mochi-cache.invalid/arrivals/${kind}/${encodeURIComponent(city)}/${encodeURIComponent(suffix)}`)
}

function routeEtaUrl(city: string, routeName: string): URL {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return url
}

function edgeCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default
}

// 記憶體層在前、Cache API 在後:Cache API 在 workers.dev 上是 no-op、
// 自訂網域上也只限同機房,單靠它冷卻旗標常常寫了就不見。
async function hasRealtimeCooldown(city: string, scope: string): Promise<boolean> {
  if (memoryCacheGet<boolean>(`arrivals/cooldown/${city}/${scope}`)) return true
  return Boolean(await edgeCache().match(arrivalCacheKey('cooldown', city, scope)))
}

async function setRealtimeCooldown(city: string, scope: string): Promise<void> {
  memoryCacheSet(`arrivals/cooldown/${city}/${scope}`, true, REALTIME_COOLDOWN_SECONDS)
  await edgeCache().put(arrivalCacheKey('cooldown', city, scope), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${REALTIME_COOLDOWN_SECONDS}` },
  }))
}

async function readLastRealtime(city: string, routeName: string): Promise<BusETAItem[]> {
  const memoized = memoryCacheGet<BusETAItem[]>(`arrivals/last/${city}/${routeName}`)
  if (memoized) return memoized
  const response = await edgeCache().match(arrivalCacheKey('last', city, routeName))
  return response ? await response.json<BusETAItem[]>() : []
}

async function writeLastRealtime(city: string, routeName: string, items: BusETAItem[]): Promise<void> {
  memoryCacheSet(`arrivals/last/${city}/${routeName}`, items, LAST_REALTIME_SECONDS)
  await edgeCache().put(arrivalCacheKey('last', city, routeName), new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LAST_REALTIME_SECONDS}`,
    },
  }))
}

map.get('/map', (c) => {
  // 深連結的標題直接從 query 組(路線名就在網址裡,不用查庫);
  // place 深連結要查 DB 才有名字,不值得為標題多一次往返,維持通用標題。
  const routeName = c.req.query('route')?.trim()
  const cityName = mapCities.find((city) => city.code === c.req.query('city')?.trim())?.name
  const meta = routeName && routeName.length <= 40
    ? { title: `${routeName} 公車路線圖｜Mochi Bus`, description: `${routeName} 的路線走向、站牌與即時到站` }
    : cityName
      ? { title: `${cityName}公車地圖｜Mochi Bus`, description: `${cityName}的公車路網、附近站牌與路線規劃` }
      : {}
  return c.html(renderMapPage(meta), 200, {
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
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    return c.json({ schemaVersion: 2, city, source: snapshotRoutes.length ? 'snapshot' : 'tdx', routes }, 200, {
      'Cache-Control': `public, max-age=${snapshotRoutes.length ? 86400 : 300}`,
    })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '路線目錄讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
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
    console.error('route_map_failed', error)
    const message = error instanceof QueryValidationError ? error.message : '暫時無法取得路線地圖'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502, {
      'Cache-Control': 'no-store',
    })
  }
})

map.get('/api/v1/map/network', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const network = await getCityNetwork(c.env, city)
    if (!network) return c.json({ error: '這個縣市尚未建立全路網資料' }, 404)
    return c.json({ schemaVersion: 1, city, ...network }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '全路網讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/vehicles', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const routeName = c.req.query('route')?.trim()
    const routeUid = c.req.query('routeUid')?.trim()
    const direction = Number(c.req.query('direction'))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!routeName || routeName.length > 40) throw new QueryValidationError('路線格式錯誤')
    const url = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/RealTimeByFrequency/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
    )
    url.searchParams.set('$format', 'JSON')
    let items: VehicleItem[] = []
    try {
      items = await fetchTDXJson<VehicleItem[]>(tdxEnv(c), url, 15)
    } catch (error) {
      console.error(JSON.stringify({
        message: 'vehicle_position_upstream_failed', city, routeName,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
    const vehicles = items
      .filter((item) => !routeUid || item.RouteUID === routeUid)
      .filter((item) => !Number.isInteger(direction) || item.Direction === direction)
      .filter((item) => Number.isFinite(item.BusPosition?.PositionLat) && Number.isFinite(item.BusPosition?.PositionLon))
      .map((item) => ({
        plate: item.PlateNumb ?? null,
        latitude: item.BusPosition!.PositionLat!,
        longitude: item.BusPosition!.PositionLon!,
        speed: item.Speed ?? null,
        azimuth: item.Azimuth ?? null,
        gpsTime: item.GPSTime ?? item.UpdateTime ?? null,
      }))
    return c.json({ schemaVersion: 1, city, routeName, vehicles }, 200, {
      'Cache-Control': 'public, max-age=15',
    })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '車輛位置讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
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
    const message = error instanceof QueryValidationError ? error.message : '站牌搜尋失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/nearby', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const latitude = Number(c.req.query('lat'))
    const longitude = Number(c.req.query('lon'))
    const radius = Math.min(2_000, Math.max(50, Number(c.req.query('radius') ?? 500)))
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) throw new QueryValidationError('座標格式錯誤')
    const places = await findNearbyStopPlaces(c.env, city, latitude, longitude, radius)
    return c.json({ schemaVersion: 1, city, radius, places }, 200, { 'Cache-Control': 'public, max-age=300' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '附近站牌查詢失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/place/:placeId/routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const routes = await getStopPlaceRoutes(c.env, city, c.req.param('placeId'))
    return c.json({ schemaVersion: 3, city, routes }, 200, { 'Cache-Control': 'public, max-age=86400' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '站牌路線讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/place/:placeId/arrivals', async (c) => {
  try {
    const env = tdxEnv(c)
    const scope = tdxScope(env)
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = c.req.param('placeId')
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
    const focusStopUid = c.req.query('focusStopUid')?.trim()
    const focusSubRouteUid = c.req.query('focusSubRouteUid')?.trim()
    const focusDirection = Number(c.req.query('focusDirection'))
    const focused = focusStopUid ? scheduledRoutes.find((route) =>
      route.stopUid === focusStopUid
      && (!Number.isInteger(focusDirection) || route.direction === focusDirection)
      && (!focusSubRouteUid || route.subRouteUid === focusSubRouteUid),
    ) : undefined
    const candidates = includeFocusedCandidate(selectRealtimeCandidates(scheduledRoutes), focused)
    const candidateRouteNames = [...new Set(candidates.map((route) => route.routeName))]
    const etaItems: BusETAItem[] = []
    const staleRouteNames = new Set<string>()
    let rateLimited = await hasRealtimeCooldown(city, scope)
    let realtimeQueries = 0
    for (const routeName of candidateRouteNames) {
      if (rateLimited) {
        const staleItems = await readLastRealtime(city, routeName)
        if (staleItems.length) {
          etaItems.push(...staleItems)
          staleRouteNames.add(routeName)
        }
        continue
      }
      try {
        const items = await fetchTDXJson<BusETAItem[]>(env, routeEtaUrl(city, routeName), 15)
        etaItems.push(...items)
        await writeLastRealtime(city, routeName, items)
        realtimeQueries += 1
      } catch (error) {
        rateLimited = error instanceof Error && error.message.includes('(429)')
        console.error(JSON.stringify({
          message: 'place_arrival_realtime_failed', city, routeName,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (rateLimited) await setRealtimeCooldown(city, scope)
        const staleItems = await readLastRealtime(city, routeName)
        if (staleItems.length) {
          etaItems.push(...staleItems)
          staleRouteNames.add(routeName)
        }
      }
    }
    const arrivals = scheduledRoutes.map((route) => {
      const realtime = selectBestEta(etaItems, route)
      const realtimeSeconds = typeof realtime?.EstimateTime === 'number' ? Math.max(0, realtime.EstimateTime) : null
      const estimateSeconds = realtimeSeconds ?? (route.scheduleMinutes === null ? null : route.scheduleMinutes * 60)
      const source = realtimeSeconds !== null
        ? staleRouteNames.has(route.routeName) ? 'stale-realtime' as const : 'realtime' as const
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
            : '暫無班次',
        stopStatus: realtime?.StopStatus ?? 0,
        source,
      }
    }).sort((a, b) =>
      (a.estimateSeconds ?? Number.POSITIVE_INFINITY) - (b.estimateSeconds ?? Number.POSITIVE_INFINITY)
      || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }),
    )
    return c.json({
      schemaVersion: 1,
      city,
      routes: arrivals,
      scheduleSource: bundle ? 'place-bundle' : 'route-objects',
      realtime: { candidates: candidates.length, queries: realtimeQueries, rateLimited },
    }, 200, { 'Cache-Control': 'public, max-age=15' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '到站時間讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/place/:placeId', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const place = await getStopPlace(c.env, city, c.req.param('placeId'))
    if (!place) return c.json({ error: '找不到這個站牌' }, 404)
    return c.json({ schemaVersion: 1, city, place }, 200, { 'Cache-Control': 'public, max-age=86400' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '站牌資料讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/direct', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const from = c.req.query('from')?.trim()
    const to = c.req.query('to')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!from || !to || from.length > 100 || to.length > 100) throw new QueryValidationError('起點或終點格式錯誤')
    const routes = await getDirectRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, routes }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '直達路線查詢失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.get('/api/v1/map/transfer', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    const from = c.req.query('from')?.trim()
    const to = c.req.query('to')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!from || !to || from.length > 100 || to.length > 100) throw new QueryValidationError('出發位置或目的地格式錯誤')
    const plans = await getOneTransferRoutes(c.env, city, from, to)
    return c.json({ schemaVersion: 1, city, from, to, plans }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '轉乘路線查詢失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502)
  }
})

map.post('/api/v1/map/journey-eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const body = await c.req.json<{
      city?: string
      legs?: Array<{ key?: string; patternId?: string; sequence?: number }>
    }>()
    const city = body.city?.trim()
    const legs = body.legs?.filter((leg): leg is { key: string; patternId: string; sequence: number } =>
      Boolean(leg.key && leg.patternId && leg.key.length <= 80 && leg.patternId.length <= 100)
      && Number.isInteger(leg.sequence) && (leg.sequence as number) >= 0,
    ) ?? []
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    if (!legs.length || legs.length > 12) throw new QueryValidationError('ETA 查詢項目格式錯誤')

    const refs = await getJourneyLegStopRefs(env, city, legs)
    // 逐路線查 ETA(legs ≤ 12,去重後更少),與站牌到站查詢共用同一份快取。
    // 不抓整縣市:雙北的全城 ETA 一包可達數十 MB,快取只有幾秒,
    // 每次規劃都重抓一次,還會把 isolate 記憶體快取撐爆。
    const routeNames = [...new Set(refs.map((ref) => ref.routeName))]
    const etaItems = (await Promise.all(routeNames.map(async (routeName) => {
      try {
        return await fetchTDXJson<BusETAItem[]>(env, routeEtaUrl(city, routeName), 15)
      } catch (error) {
        console.error(JSON.stringify({
          message: 'journey_eta_upstream_failed',
          city,
          routeName,
          error: error instanceof Error ? error.message : String(error),
        }))
        return [] as BusETAItem[]
      }
    }))).flat()
    const realtimeEstimates = new Map<string, JourneyEstimate>(refs.map((ref) => {
      const item = etaItems.find((candidate) =>
        candidate.RouteUID === ref.routeUid
        && candidate.StopUID === ref.stopUid
        && candidate.Direction === ref.direction,
      )
      const estimateSeconds = typeof item?.EstimateTime === 'number' ? Math.max(0, item.EstimateTime) : null
      return [ref.key, {
        key: ref.key,
        routeName: ref.routeName,
        stopUid: ref.stopUid,
        estimateSeconds,
        minutes: estimateSeconds === null ? null : Math.ceil(estimateSeconds / 60),
        stopStatus: item?.StopStatus ?? null,
        source: estimateSeconds === null ? 'none' as const : 'realtime' as const,
      }] as const
    }))

    const missingRefs = refs.filter((ref) => realtimeEstimates.get(ref.key)?.minutes === null)
    if (missingRefs.length) {
      try {
        const routeNames = [...new Set(missingRefs.map((ref) => ref.routeName))]
        const schedules = (await Promise.all(routeNames.map(async (routeName) =>
          await getSnapshotSchedule(env, city, routeName)
          ?? await getBusSchedule(env, city, routeName),
        ))).flat()
        const scheduled = getScheduledEstimates(missingRefs, schedules)
        scheduled.forEach((estimate, key) => realtimeEstimates.set(key, estimate))
      } catch (error) {
        console.error(JSON.stringify({
          message: 'journey_schedule_fallback_failed',
          city,
          error: error instanceof Error ? error.message : String(error),
        }))
      }
    }
    const estimates = refs.map((ref) => realtimeEstimates.get(ref.key))
    return c.json({ schemaVersion: 1, city, fetchedAt: new Date().toISOString(), estimates }, 200, {
      'Cache-Control': 'no-store',
    })
  } catch (error) {
    console.error(JSON.stringify({
      message: 'journey_eta_failed',
      error: error instanceof Error ? error.message : String(error),
    }))
    const message = error instanceof QueryValidationError ? error.message : 'ETA 排序資料讀取失敗'
    return c.json({ error: message }, error instanceof QueryValidationError ? 400 : 502, {
      'Cache-Control': 'no-store',
    })
  }
})

type JourneyEstimate = {
  key: string
  routeName: string
  stopUid: string
  estimateSeconds: number | null
  minutes: number | null
  stopStatus: number | null
  source: 'none' | 'realtime' | 'schedule'
}

function getScheduledEstimates(
  refs: Awaited<ReturnType<typeof getJourneyLegStopRefs>>,
  schedules: ScheduleItem[],
) {
  const now = new Date()
  const result = new Map<string, JourneyEstimate>()

  refs.forEach((ref) => {
    const scheduled = nextScheduledMinutes(schedules, {
      stopUid: ref.stopUid, direction: ref.direction, subRouteUid: ref.patternId.split(':')[0],
    }, now)
    // 明天才有車的班次對「現在出發」的行程排序沒有意義(會顯示成幾百分鐘到站),
    // 當作沒有估計,讓候選清單退回站數排序。
    const estimate = scheduled?.nextDay ? null : scheduled
    result.set(ref.key, {
      key: ref.key,
      routeName: ref.routeName,
      stopUid: ref.stopUid,
      estimateSeconds: estimate === null ? null : estimate.minutes * 60,
      minutes: estimate?.minutes ?? null,
      stopStatus: null,
      source: 'schedule',
    })
  })
  return result
}

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

export default map
