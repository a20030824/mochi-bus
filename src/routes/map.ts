import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { mapCities } from '../config/map-cities'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import {
  realtimeJourneyEstimate,
  scheduledJourneyEstimates,
  type JourneyEstimate,
} from '../domain/map/journey-estimate'
import type { ScheduleItem } from '../domain/schedule'
import {
  getJourneyLegStopRefs,
  getSnapshotSchedule,
} from '../infrastructure/transit/snapshot-repository'
import { fetchTDXJson, getBusSchedule, isRejectedUserTdxToken, isTDXRecordArray, tdxRouteScope, tdxWarningFromError, type BusETAItem, type TDXWarning } from '../lib/tdx'
import {
  ApiInputError,
  JOURNEY_ETA_BODY_LIMIT_BYTES,
  parseJourneyEtaInput,
  readJsonBody,
} from '../lib/api-input'
import { journeyEtaOutcome } from '../observability/map-api-outcomes'
import type { TelemetryCity } from '../observability/telemetry'
import { renderMapPage } from '../map-page'
import {
  beginMapOperation,
  completeMapError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'
import {
  findNearbyPlaces,
  readPlace,
  readPlaceRoutes,
  readStopPlace,
  searchPlaces,
} from './map-place-lookups'
import { readDirectRoutes, readTransferPlans } from './map-journey-plans'
import { readRouteMap, readRouteTimetable } from './map-route-reads'
import { readCityNetwork } from './map-network-read'
import { readRouteCatalog } from './map-route-catalog'
import { readVehicles } from './map-vehicles-read'
import { readPlaceArrivals } from './map-place-arrivals'

const map = new Hono<MapEnv>()

function strongerTDXWarning(current: TDXWarning | undefined, next: TDXWarning | undefined): TDXWarning | undefined {
  const priority: Record<TDXWarning, number> = {
    'tdx-unavailable': 1,
    'tdx-rate-limit': 2,
    'tdx-quota': 3,
  }
  if (!next || (current && priority[current] >= priority[next])) return current
  return next
}

function routeEtaUrl(city: string, routeName: string, routeUid?: string): URL {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return url
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

map.get('/api/v1/map/routes', readRouteCatalog)

map.get('/api/v1/map/route', readRouteMap)

map.get('/api/v1/map/timetable', readRouteTimetable)

map.get('/api/v1/map/network', readCityNetwork)

map.get('/api/v1/map/vehicles', readVehicles)

map.get('/api/v1/map/search', searchPlaces)

map.get('/api/v1/map/nearby', findNearbyPlaces)

map.get('/api/v1/map/place/:placeId/routes', readPlaceRoutes)

map.get('/api/v1/map/place/:placeId/arrivals', readPlaceArrivals)

map.get('/api/v1/map/place/:placeId', readPlace)

map.get('/api/v1/map/stop-place', readStopPlace)

map.get('/api/v1/map/direct', readDirectRoutes)

map.get('/api/v1/map/transfer', readTransferPlans)

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

export default map
