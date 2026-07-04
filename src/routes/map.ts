import { Hono } from 'hono'
import { mapCities } from '../config/map-cities'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { matchingEtaItems, selectBestEta } from '../domain/map/eta'
import { includeFocusedCandidate, selectRealtimeCandidates } from '../domain/map/arrival-ranking'
import { nextScheduledMinutes, type ScheduleItem, type ScheduleQuery } from '../domain/schedule'
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
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import { fetchTDXJson, formatETALabel, getBusSchedule, getRouteCatalog, type BusETAItem, type TDXEnv } from '../lib/tdx'
import { renderMapPage } from '../map-page'

type Env = { Bindings: TDXEnv & TransitBindings }
const map = new Hono<Env>()

const REALTIME_COOLDOWN_SECONDS = 60
const LAST_REALTIME_SECONDS = 120

function arrivalCacheKey(kind: 'cooldown' | 'last', city: string, routeName = ''): Request {
  return new Request(`https://mochi-cache.invalid/arrivals/${kind}/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`)
}

function edgeCache(): Cache {
  return (caches as CacheStorage & { default: Cache }).default
}

async function hasRealtimeCooldown(city: string): Promise<boolean> {
  return Boolean(await edgeCache().match(arrivalCacheKey('cooldown', city)))
}

async function setRealtimeCooldown(city: string): Promise<void> {
  await edgeCache().put(arrivalCacheKey('cooldown', city), new Response('1', {
    headers: { 'Cache-Control': `public, max-age=${REALTIME_COOLDOWN_SECONDS}` },
  }))
}

async function readLastRealtime(city: string, routeName: string): Promise<BusETAItem[]> {
  const response = await edgeCache().match(arrivalCacheKey('last', city, routeName))
  return response ? await response.json<BusETAItem[]>() : []
}

async function writeLastRealtime(city: string, routeName: string, items: BusETAItem[]): Promise<void> {
  await edgeCache().put(arrivalCacheKey('last', city, routeName), new Response(JSON.stringify(items), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${LAST_REALTIME_SECONDS}`,
    },
  }))
}

map.get('/map', (c) => c.html(renderMapPage(), 200, {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}))

map.get('/api/v1/map/cities', (c) => c.json({ schemaVersion: 1, cities: mapCities }, 200, {
  'Cache-Control': 'public, max-age=86400',
}))

map.get('/api/v1/map/routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(c.env, city)
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
      : await getRouteMapVariants(c.env, city, routeName)
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
      items = await fetchTDXJson<VehicleItem[]>(c.env, url, 15)
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
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇城市')
    const placeId = c.req.param('placeId')
    const bundle = await getStopPlaceBundle(c.env, city, placeId)
    const now = new Date()
    const scheduledRoutes = bundle ? bundle.routes.map(({ schedules, ...route }) => ({
      ...route,
      ...scheduleFields(schedules, {
        stopUid: route.stopUid,
        direction: route.direction,
        subRouteUid: route.subRouteUid,
      }, now),
    })) : await (async () => {
      const routes = await getStopPlaceRoutes(c.env, city, placeId)
      const routeNames = [...new Set(routes.map((route) => route.routeName))]
      const schedulesByRoute = new Map((await Promise.all(routeNames.map(async (routeName) => [
        routeName,
        await getSnapshotSchedule(c.env, city, routeName) ?? [],
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
    let rateLimited = await hasRealtimeCooldown(city)
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
      const etaUrl = new URL(
        `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
      )
      etaUrl.searchParams.set('$format', 'JSON')
      try {
        const items = await fetchTDXJson<BusETAItem[]>(c.env, etaUrl, 15)
        etaItems.push(...items)
        await writeLastRealtime(city, routeName, items)
        realtimeQueries += 1
      } catch (error) {
        rateLimited = error instanceof Error && error.message.includes('(429)')
        console.error(JSON.stringify({
          message: 'place_arrival_realtime_failed', city, routeName,
          error: error instanceof Error ? error.message : String(error),
        }))
        if (rateLimited) await setRealtimeCooldown(city)
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
          ? formatETALabel(Math.ceil((realtimeSeconds as number) / 60), realtime?.StopStatus ?? 0).replace('分鐘', '分')
          : source === 'schedule'
            ? route.scheduleHeadway
              ? `${route.scheduleHeadway[0]}–${route.scheduleHeadway[1]} 分一班`
              : route.scheduleDepartureBased
                ? `${Math.max(1, route.scheduleMinutes ?? 1)} 分後發車`
                : `約 ${Math.max(1, route.scheduleMinutes ?? 1)} 分`
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

map.get('/api/v1/map/place/:placeId/legacy-arrivals', async (c) => {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const routes = await getStopPlaceRoutes(c.env, city, c.req.param('placeId'))
    const stopUids = [...new Set(routes.map((route) => route.stopUid))]
    const stopNames = [...new Set(routes.map((route) => route.stopName))]
    let etaItems: BusETAItem[] = []
    let etaUpstreamAvailable = true
    if (stopUids.length) {
      const nameResults = await Promise.allSettled(stopNames.map(async (stopName) => {
        const etaUrl = new URL(
          `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}`,
        )
        etaUrl.searchParams.set('$filter', `StopName/Zh_tw eq '${stopName.replaceAll("'", "''")}'`)
        etaUrl.searchParams.set('$format', 'JSON')
        return await fetchTDXJson<BusETAItem[]>(c.env, etaUrl, 8)
      }))
      etaUpstreamAvailable = nameResults.some((result) => result.status === 'fulfilled')
      etaItems = nameResults.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      nameResults.forEach((result) => {
        if (result.status === 'rejected') console.error('place_eta_name_failed', city, c.req.param('placeId'), result.reason)
      })

      const hasMatchingItem = routes.some((route) => matchingEtaItems(etaItems, route).length > 0)
      if (!hasMatchingItem) {
        const routeNames = [...new Set(routes.map((route) => route.routeName))]
        const fallbackResults = await Promise.allSettled(routeNames.map(async (routeName) => {
          const etaUrl = new URL(
            `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
          )
          etaUrl.searchParams.set('$format', 'JSON')
          return await fetchTDXJson<BusETAItem[]>(c.env, etaUrl, 8)
        }))
        if (fallbackResults.some((result) => result.status === 'fulfilled')) etaUpstreamAvailable = true
        etaItems.push(...fallbackResults.flatMap((result) => result.status === 'fulfilled' ? result.value : []))
      }
    }
    const withEta = routes.map((route) => {
      const eta = selectBestEta(etaItems, route)
      const estimateSeconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
      const stopStatus = eta?.StopStatus ?? 0
      return {
        ...route,
        estimateSeconds,
        etaLabel: etaUpstreamAvailable ? formatETALabel(
          estimateSeconds === null ? null : Math.ceil(estimateSeconds / 60),
          stopStatus,
        ) : '即時資料暫時無法取得',
        stopStatus,
      }
    })
    return c.json({ schemaVersion: 2, city, etaAvailable: etaUpstreamAvailable, routes: withEta }, 200, { 'Cache-Control': 'public, max-age=8' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '站牌路線查詢失敗'
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

    const refs = await getJourneyLegStopRefs(c.env, city, legs)
    const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}`)
    url.searchParams.set('$format', 'JSON')
    let etaItems: BusETAItem[] = []
    try {
      etaItems = await fetchTDXJson<BusETAItem[]>(c.env, url, 8)
    } catch (error) {
      console.error(JSON.stringify({
        message: 'journey_eta_upstream_failed',
        city,
        error: error instanceof Error ? error.message : String(error),
      }))
    }
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
          await getSnapshotSchedule(c.env, city, routeName)
          ?? await getBusSchedule(c.env, city, routeName),
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
    const estimate = nextScheduledMinutes(schedules, {
      stopUid: ref.stopUid, direction: ref.direction, subRouteUid: ref.patternId.split(':')[0],
    }, now)
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
  }
}

export default map
