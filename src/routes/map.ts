import { Hono } from 'hono'
import { mapCities } from '../config/map-cities'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { getRouteMapVariants } from '../infrastructure/tdx/map'
import {
  findNearbyStopPlaces,
  getCityNetwork,
  getDirectRoutes,
  getJourneyLegStopRefs,
  getOneTransferRoutes,
  getSnapshotRouteVariants,
  getStopPlaceRoutes,
  type TransitBindings,
} from '../infrastructure/transit/snapshot-repository'
import { fetchTDXJson, type BusETAItem, type TDXEnv } from '../lib/tdx'
import { renderMapPage } from '../map-page'

type Env = { Bindings: TDXEnv & TransitBindings }
const map = new Hono<Env>()

map.get('/map', (c) => c.html(renderMapPage(), 200, {
  'Cache-Control': 'no-cache',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
}))

map.get('/api/v1/map/cities', (c) => c.json({ schemaVersion: 1, cities: mapCities }, 200, {
  'Cache-Control': 'public, max-age=86400',
}))

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
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')
    const routes = await getStopPlaceRoutes(c.env, city, c.req.param('placeId'))
    return c.json({ schemaVersion: 1, city, routes }, 200, { 'Cache-Control': 'public, max-age=86400' })
  } catch (error) {
    const message = error instanceof QueryValidationError ? error.message : '站牌路線查詢失敗'
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
        const scheduleUrl = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/City/${encodeURIComponent(city)}`)
        scheduleUrl.searchParams.set('$format', 'JSON')
        const schedules = await fetchTDXJson<ScheduleItem[]>(c.env, scheduleUrl, 6 * 60 * 60)
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

type ScheduleItem = {
  SubRouteUID?: string
  Direction?: number
  Timetables?: Array<{
    ServiceDay?: Record<string, number>
    StopTimes?: Array<{
      StopUID?: string
      ArrivalTime?: string
      DepartureTime?: string
    }>
  }>
}

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
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sunday'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  const nowMinutes = hour * 60 + minute
  const result = new Map<string, JourneyEstimate>()

  refs.forEach((ref) => {
    const subRouteUid = ref.patternId.split(':')[0]
    const schedule = schedules.find((item) =>
      (!subRouteUid || item.SubRouteUID === subRouteUid) && item.Direction === ref.direction,
    ) ?? schedules.find((item) => item.Direction === ref.direction
      && item.Timetables?.some((timetable) => timetable.StopTimes?.some((stop) => stop.StopUID === ref.stopUid)))
    const candidates = (schedule?.Timetables ?? [])
      .filter((timetable) => timetable.ServiceDay?.[weekday] === 1)
      .flatMap((timetable) => timetable.StopTimes ?? [])
      .filter((stop) => stop.StopUID === ref.stopUid)
      .map((stop) => timeToMinutes(stop.ArrivalTime ?? stop.DepartureTime))
      .filter((value): value is number => value !== null && value >= nowMinutes)
      .map((value) => value - nowMinutes)
    const minutes = candidates.length ? Math.min(...candidates) : null
    result.set(ref.key, {
      key: ref.key,
      routeName: ref.routeName,
      stopUid: ref.stopUid,
      estimateSeconds: minutes === null ? null : minutes * 60,
      minutes,
      stopStatus: null,
      source: 'schedule',
    })
  })
  return result
}

function timeToMinutes(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}

export default map
