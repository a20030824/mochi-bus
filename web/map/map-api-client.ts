import type { TransferEstimate } from '../../src/domain/map/transfer-estimate'
import type { EtaSource } from '../../src/domain/eta-presentation'
import type { TDXWarning } from '../../src/domain/tdx-warning'
import { requestMochiJson } from '../tdx/api-client'

export type RegionCode = 'north' | 'central' | 'south' | 'east' | 'islands'

export type MapCity = {
  code: string
  name: string
  region: RegionCode
  center: [number, number]
  labelOffset?: [number, number]
}

export type RouteItem = {
  routeName: string
  category: string
}

export type RouteMapVariant = {
  variantKey: string
  routeName: string
  routeUid: string
  subRouteUid?: string
  direction: 0 | 1 | 2
  label: string
  subRouteName: string
  shape: GeoJSON.Feature<GeoJSON.LineString>
  stops: GeoJSON.FeatureCollection<GeoJSON.Point, {
    stopUid: string
    stopName: string
    sequence: number
  }>
  updatedAt: string | null
}

export type TimetableStop = {
  stopUid: string
  stopName: string
  sequence: number
  hasTimes: boolean
}

export type TimetablePeriod = {
  startTime: string
  endTime: string
  minHeadwayMinutes: number
  maxHeadwayMinutes: number
}

export type TimetableService = {
  id: string
  label: string
  days: number[]
  today: boolean
  times: string[]
  periods: TimetablePeriod[]
  firstTime: string | null
  lastTime: string | null
}

export type RouteTimetable = {
  mode: 'stop' | 'departure' | 'frequency' | 'none'
  selectedStop: Omit<TimetableStop, 'hasTimes'> | null
  departureStop: Omit<TimetableStop, 'hasTimes'> | null
  stops: TimetableStop[]
  timedStopCount: number
  services: TimetableService[]
}

export type RouteTimetableResponse = {
  schemaVersion: number
  city: string
  routeName: string
  variantKey: string
  routeUid: string
  direction: 0 | 1 | 2
  source: 'snapshot' | 'tdx'
  timetable: RouteTimetable
}

export type NearbyPlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters: number
}

export type SearchPlace = Omit<NearbyPlace, 'distanceMeters'>

export type PlaceRoute = {
  routeUid: string
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopName: string
  stopSequence: number
  estimateSeconds: number | null
  etaLabel: string
  stopStatus: number
  source?: 'realtime' | 'stale-realtime' | 'schedule' | 'none'
}

export type PlaceArrivalsResponse = {
  routes: PlaceRoute[]
  warning?: TDXWarning
  realtime?: {
    candidates: number
    queries: number
    rateLimited: boolean
  }
}

export type DirectRoute = PlaceRoute & {
  boardSequence: number
  alightSequence: number
  stopCount: number
  etaMinutes?: number | null
  etaSource?: EtaSource
  etaDepartureBased?: boolean
  etaHeadwayMinutes?: [number, number] | null
  etaNextDay?: boolean
}

export type TransferLeg = {
  routeName: string
  variantKey: string
  label: string
  boardSequence: number
  alightSequence: number
  stopCount: number
}

export type TransferPlan = {
  transferPlaceId: string
  secondTransferPlaceId?: string
  transferName: string
  transferWalkMeters?: number
  totalStops: number
  first: TransferLeg
  second: TransferLeg
  firstEtaMinutes?: number | null
  secondEtaMinutes?: number | null
  firstEtaSource?: EtaSource
  secondEtaSource?: EtaSource
  firstEtaDepartureBased?: boolean
  secondEtaDepartureBased?: boolean
  firstEtaHeadwayMinutes?: [number, number] | null
  secondEtaHeadwayMinutes?: [number, number] | null
  firstEtaNextDay?: boolean
  secondEtaNextDay?: boolean
  transferEstimate?: TransferEstimate
}

export type CityNetwork = {
  version: string
  routes: Array<{
    routeName: string
    variantKey: string
    label: string
    shape: GeoJSON.Feature<GeoJSON.LineString>
  }>
  places: SearchPlace[]
}

export type VehiclePosition = {
  plate: string | null
  latitude: number
  longitude: number
  speed: number | null
  azimuth: number | null
  gpsTime: string | null
}

export type VehiclePositionsResponse = {
  vehicles: VehiclePosition[]
  warning?: TDXWarning
}

export type JourneyEtaEstimate = {
  key: string
  minutes: number | null
  source: EtaSource
  departureBased?: boolean
  headwayMinutes?: [number, number] | null
  nextDay?: boolean
}

export const mapApi = {
  async cities(): Promise<MapCity[]> {
    const data = await requestJson<{ cities?: MapCity[] }>('/api/v1/map/cities', {}, false, '地圖初始化失敗')
    if (!data.cities) throw new Error('地圖初始化失敗')
    return data.cities
  },

  async locate(signal?: AbortSignal): Promise<{ latitude: number; longitude: number }> {
    const data = await requestJson<{ latitude?: number; longitude?: number }>(
      '/api/v1/map/locate',
      { cache: 'no-store', signal },
      false,
      '這次判斷不出位置，直接手動選吧',
    )
    if (typeof data.latitude !== 'number' || typeof data.longitude !== 'number') {
      throw new Error('這次判斷不出位置，直接手動選吧')
    }
    return { latitude: data.latitude, longitude: data.longitude }
  },

  async routes(city: string, signal?: AbortSignal): Promise<RouteItem[]> {
    const data = await requestJson<{ routes?: RouteItem[] }>(
      `/api/v1/map/routes?city=${encodeURIComponent(city)}`,
      { signal },
      true,
      '目前無法載入這個縣市的路線',
    )
    if (!data.routes) throw new Error('目前無法載入這個縣市的路線')
    return data.routes
  },

  async search(city: string, query: string, signal?: AbortSignal): Promise<SearchPlace[]> {
    const params = new URLSearchParams({ city, q: query })
    const data = await requestJson<{ places?: SearchPlace[] }>(`/api/v1/map/search?${params}`, { signal })
    return data.places ?? []
  },

  async routeVariants(city: string, routeName: string, signal?: AbortSignal): Promise<RouteMapVariant[]> {
    const params = new URLSearchParams({ city, route: routeName })
    const data = await requestJson<{ variants?: RouteMapVariant[] }>(
      `/api/v1/map/route?${params}`,
      { signal },
      true,
      '目前無法取得這條路線',
    )
    if (!data.variants?.length) throw new Error('目前無法取得這條路線')
    return data.variants
  },

  async routeVariant(city: string, routeName: string, variantKey: string): Promise<RouteMapVariant | undefined> {
    try {
      return (await mapApi.routeVariants(city, routeName)).find((variant) => variant.variantKey === variantKey)
    } catch {
      return undefined
    }
  },

  async timetable(city: string, variant: RouteMapVariant, stopUid?: string, signal?: AbortSignal): Promise<RouteTimetableResponse> {
    const params = new URLSearchParams({
      city,
      route: variant.routeName,
      routeUid: variant.routeUid,
      variant: variant.variantKey,
      direction: String(variant.direction),
    })
    if (variant.subRouteUid) params.set('subRouteUid', variant.subRouteUid)
    if (stopUid) params.set('stopUid', stopUid)
    return requestJson<RouteTimetableResponse>(
      `/api/v1/map/timetable?${params}`,
      { signal },
      true,
      '目前無法取得時刻表',
    )
  },

  async vehicles(city: string, variant: RouteMapVariant, signal?: AbortSignal): Promise<VehiclePositionsResponse> {
    const params = new URLSearchParams({
      city,
      route: variant.routeName,
      routeUid: variant.routeUid,
      direction: String(variant.direction),
    })
    const data = await requestJson<{ vehicles?: VehiclePosition[]; warning?: TDXWarning }>(
      `/api/v1/map/vehicles?${params}`,
      { cache: 'no-store', signal },
      true,
    )
    return { vehicles: data.vehicles ?? [], warning: data.warning }
  },

  async network(city: string, signal?: AbortSignal): Promise<CityNetwork> {
    return requestJson<CityNetwork>(`/api/v1/map/network?city=${encodeURIComponent(city)}`, { signal })
  },

  async nearby(city: string, latitude: number, longitude: number, radius: number, signal?: AbortSignal): Promise<NearbyPlace[]> {
    const params = new URLSearchParams({
      city,
      lat: String(latitude),
      lon: String(longitude),
      radius: String(radius),
    })
    const data = await requestJson<{ places?: NearbyPlace[] }>(`/api/v1/map/nearby?${params}`, { signal })
    if (!data.places) throw new Error('附近站牌讀取失敗')
    return data.places
  },

  async direct(city: string, from: string, to: string, signal?: AbortSignal): Promise<DirectRoute[]> {
    const params = new URLSearchParams({ city, from, to })
    const data = await requestJson<{ routes?: DirectRoute[] }>(`/api/v1/map/direct?${params}`, { signal })
    if (!data.routes) throw new Error('直達路線查詢失敗')
    return data.routes
  },

  async transfer(city: string, from: string, to: string, signal?: AbortSignal): Promise<TransferPlan[]> {
    const params = new URLSearchParams({ city, from, to })
    const data = await requestJson<{ plans?: TransferPlan[] }>(`/api/v1/map/transfer?${params}`, { signal })
    if (!data.plans) throw new Error('轉乘路線查詢失敗')
    return data.plans
  },

  async journeyEta(
    city: string,
    legs: Array<{ key: string; patternId: string; sequence: number }>,
    signal?: AbortSignal,
  ): Promise<{ estimates: JourneyEtaEstimate[]; warning?: TDXWarning }> {
    const data = await requestJson<{ estimates?: Array<Partial<JourneyEtaEstimate> & { key?: unknown }>; warning?: TDXWarning }>(
      '/api/v1/map/journey-eta',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, legs }),
        signal,
      },
      true,
    )
    const validSources = new Set<EtaSource>(['none', 'realtime', 'stale-realtime', 'schedule'])
    const estimates = (data.estimates ?? [])
      .filter((estimate): estimate is Partial<JourneyEtaEstimate> & { key: string } => typeof estimate.key === 'string')
      .map((estimate): JourneyEtaEstimate => {
        const source = typeof estimate.source === 'string' && validSources.has(estimate.source as EtaSource)
          ? estimate.source as EtaSource
          : 'none'
        const minutes = typeof estimate.minutes === 'number' && Number.isFinite(estimate.minutes) && estimate.minutes >= 0
          ? estimate.minutes
          : null
        const headway = Array.isArray(estimate.headwayMinutes)
          && estimate.headwayMinutes.length === 2
          && estimate.headwayMinutes.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)
          ? estimate.headwayMinutes as [number, number]
          : null
        return {
          key: estimate.key,
          minutes: source === 'none' ? null : minutes,
          source,
          departureBased: estimate.departureBased === true,
          headwayMinutes: headway,
          nextDay: estimate.nextDay === true,
        }
      })
    return { estimates, warning: data.warning }
  },

  async place(city: string, placeId: string, signal?: AbortSignal): Promise<NearbyPlace> {
    const data = await requestJson<{ place?: NearbyPlace }>(
      `/api/v1/map/place/${encodeURIComponent(placeId)}?city=${encodeURIComponent(city)}`,
      { signal },
    )
    if (!data.place) throw new Error('找不到這個站牌')
    return data.place
  },

  async stopPlace(city: string, stopUid: string, signal?: AbortSignal): Promise<NearbyPlace> {
    const params = new URLSearchParams({ city, stopUid })
    const data = await requestJson<{ place?: NearbyPlace }>(`/api/v1/map/stop-place?${params}`, { signal })
    if (!data.place) throw new Error('找不到這個站牌')
    return data.place
  },

  async placeRoutes(city: string, placeId: string, signal?: AbortSignal): Promise<PlaceArrivalsResponse> {
    const data = await requestJson<Partial<PlaceArrivalsResponse>>(
      `/api/v1/map/place/${encodeURIComponent(placeId)}/arrivals?city=${encodeURIComponent(city)}`,
      { signal },
      true,
      '站牌路線讀取失敗',
    )
    if (!data.routes) throw new Error('站牌路線讀取失敗')
    return { ...data, routes: data.routes }
  },
}

async function requestJson<T>(
  url: string,
  init: RequestInit = {},
  authenticated = false,
  fallback = '資料讀取失敗',
): Promise<T> {
  return requestMochiJson<T>(url, init, { authenticated, fallback })
}
