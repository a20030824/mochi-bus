import type { BusQuery, Direction, ResolvedBusQuery } from '../domain/bus-query'
import { classifyRouteName, type RouteCategory } from '../domain/route-category'

export type TDXEnv = {
  TDX_CLIENT_ID: string
  TDX_CLIENT_SECRET: string
}

type LocalizedName = {
  Zh_tw?: string
  En?: string
}

export type BusETAItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  StopUID?: string
  StopName?: LocalizedName
  Direction?: number
  EstimateTime?: number | null
  StopStatus?: number
  DataTime?: string
  SrcUpdateTime?: string
  SrcTransTime?: string
  UpdateTime?: string
}

type StopOfRouteItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  SubRouteUID?: string
  SubRouteName?: LocalizedName
  Direction?: number
  Stops?: Array<{
    StopUID?: string
    StopName?: LocalizedName
    StopSequence?: number
    StopPosition?: {
      PositionLat?: number
      PositionLon?: number
    }
  }>
}

type RouteItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  DepartureStopNameZh?: string
  DestinationStopNameZh?: string
}

type StopItem = {
  StopUID?: string
  StopName?: LocalizedName
  StopPosition?: {
    PositionLat?: number
    PositionLon?: number
  }
}

export type RouteCatalogItem = {
  routeUid?: string
  routeName: string
  departure?: string
  destination?: string
  category: RouteCategory
}

export type RouteStop = {
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopName: string
  direction: Direction
  sequence: number
  position?: {
    latitude: number
    longitude: number
  }
}

export type StopGroup = {
  direction: Direction
  label: string
  routeUid?: string
  subRouteUid?: string
  subRouteName: string
  stops: RouteStop[]
}

export type ETAResult = {
  routeName: string
  stopName: string
  stopUid: string
  direction: number
  estimateSeconds: number | null
  minutes: number | null
  label: string
  stopStatus: number
  statusLabel: string
  dataTime: string | null
  fetchedAt: string
  stale: boolean
}

export type StopRouteSuggestion = ResolvedBusQuery & {
  label: string
  directionLabel: string
}

export type RouteDetail = {
  routeName: string
  direction: Direction
  label: string
  stops: Array<{
    stopUid: string
    stopName: string
    sequence: number
    selected: boolean
    etaLabel: string | null
  }>
}

export class QueryResolutionError extends Error {
  constructor(message: string, readonly candidates: RouteStop[] = []) {
    super(message)
    this.name = 'QueryResolutionError'
  }
}

type TokenCache = { value: string; expiresAt: number }
let tokenCache: TokenCache | undefined
let pendingToken: Promise<string> | undefined

const ETA_CACHE_SECONDS = 8
const STATIC_CACHE_SECONDS = 60 * 60
const STALE_AFTER_MS = 3 * 60 * 1000
const REQUEST_TIMEOUT_MS = 6000

export async function getTDXToken(env: TDXEnv): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.value
  if (pendingToken) return pendingToken

  pendingToken = fetchTDXToken(env)
  try {
    return await pendingToken
  } finally {
    pendingToken = undefined
  }
}

async function fetchTDXToken(env: TDXEnv): Promise<string> {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: env.TDX_CLIENT_ID,
    client_secret: env.TDX_CLIENT_SECRET,
  })
  const response = await fetch(
    'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  )

  if (!response.ok) throw new Error(`TDX token request failed (${response.status})`)
  const data = await response.json() as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new Error('TDX token response is missing access_token')

  const expiresIn = Math.max(60, data.expires_in ?? 3600)
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
  }
  return data.access_token
}

export async function resolveBusQuery(env: TDXEnv, query: BusQuery): Promise<ResolvedBusQuery> {
  const groups = await getRouteStopGroups(env, query.city, query.routeName)
  const candidates = groups
    .flatMap((group) => group.stops)
    .filter((stop) => stop.direction === query.direction)
    .filter((stop) => query.stopUid
      ? stop.stopUid === query.stopUid
      : stop.stopName === query.stopName)

  const unique = dedupeStops(candidates)
  if (unique.length === 0) {
    throw new QueryResolutionError(`找不到 ${query.routeName} 的 ${query.stopName ?? query.stopUid}`)
  }
  if (unique.length > 1) {
    throw new QueryResolutionError('找到多個同名站牌，請選擇正確站牌', unique)
  }

  const match = unique[0]
  return {
    ...query,
    routeUid: query.routeUid ?? match.routeUid,
    stopUid: match.stopUid,
    stopName: match.stopName,
  }
}

export async function getCommuteETA(env: TDXEnv, query: ResolvedBusQuery): Promise<ETAResult> {
  const items = await getBusETA(env, query)
  const item = items.find((candidate) =>
    candidate.StopUID === query.stopUid && candidate.Direction === query.direction,
  ) ?? {
    RouteName: { Zh_tw: query.routeName },
    StopName: { Zh_tw: query.stopName },
    StopUID: query.stopUid,
    Direction: query.direction,
    StopStatus: 0,
    DataTime: new Date().toISOString(),
  }

  if (!item) throw new Error(`目前沒有 ${query.routeName}／${query.stopName} 的到站資料`)
  return toETAResult(item, query)
}

export async function getRouteStopGroups(
  env: TDXEnv,
  city: string,
  routeName: string,
): Promise<StopGroup[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  const data = await fetchTDXJson<StopOfRouteItem[]>(env, url, STATIC_CACHE_SECONDS)

  const groups = data
    .filter((item): item is StopOfRouteItem & { Direction: Direction } =>
      item.Direction === 0 || item.Direction === 1,
    )
    .map((item) => {
      const stops = (item.Stops ?? [])
        .filter((stop): stop is typeof stop & { StopUID: string } => Boolean(stop.StopUID && stop.StopName?.Zh_tw))
        .map((stop) => ({
          routeUid: item.RouteUID,
          subRouteUid: item.SubRouteUID,
          subRouteName: item.SubRouteName?.Zh_tw ?? item.RouteName?.Zh_tw ?? routeName,
          stopUid: stop.StopUID,
          stopName: stop.StopName?.Zh_tw ?? '未知站牌',
          direction: item.Direction,
          sequence: stop.StopSequence ?? 0,
          position: typeof stop.StopPosition?.PositionLat === 'number' && typeof stop.StopPosition.PositionLon === 'number'
            ? { latitude: stop.StopPosition.PositionLat, longitude: stop.StopPosition.PositionLon }
            : undefined,
        }))
        .sort((a, b) => a.sequence - b.sequence)

      const first = stops.at(0)?.stopName ?? '起點未知'
      const last = stops.at(-1)?.stopName ?? '終點未知'
      return {
        direction: item.Direction,
        label: `${first} → ${last}`,
        routeUid: item.RouteUID,
        subRouteUid: item.SubRouteUID,
        subRouteName: item.SubRouteName?.Zh_tw ?? item.RouteName?.Zh_tw ?? routeName,
        stops,
      }
    })
    .filter((group) => group.stops.length > 0)

  return mergeEquivalentStopGroups(groups)
}

export function mergeEquivalentStopGroups(groups: StopGroup[]): StopGroup[] {
  const merged = new Map<string, StopGroup>()
  for (const group of groups) {
    // StopUID 可能因支線而不同；以完整站名序列判斷是否真的是同一路徑。
    const signature = `${group.direction}:${group.stops.map((stop) => stop.stopName).join('>')}`
    const existing = merged.get(signature)
    if (!existing) {
      merged.set(signature, group)
      continue
    }

    const names = new Set([...existing.subRouteName.split('／'), group.subRouteName])
    existing.subRouteName = [...names].join('／')
  }

  return [...merged.values()]
}

export async function getRouteCatalog(env: TDXEnv, city: string): Promise<RouteCatalogItem[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/Route/City/${encodeURIComponent(city)}`,
  )
  url.searchParams.set('$format', 'JSON')
  const data = await fetchTDXJson<RouteItem[]>(env, url, STATIC_CACHE_SECONDS)

  const routes = data
    .filter((item): item is RouteItem & { RouteName: { Zh_tw: string } } => Boolean(item.RouteName?.Zh_tw))
    .map((item) => ({
      routeUid: item.RouteUID,
      routeName: item.RouteName.Zh_tw,
      departure: item.DepartureStopNameZh,
      destination: item.DestinationStopNameZh,
      category: classifyRouteName(item.RouteName.Zh_tw),
    }))

  return [...new Map(routes.map((route) => [route.routeName, route])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
}

export async function getStopRouteSuggestions(
  env: TDXEnv,
  city: string,
  stopName: string,
  anchorStopUid?: string,
): Promise<StopRouteSuggestion[]> {
  const etaUrl = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(city)}`,
  )
  const stopUrl = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/Stop/City/${encodeURIComponent(city)}`,
  )
  const filter = `StopName/Zh_tw eq '${stopName.replaceAll("'", "''")}'`
  etaUrl.searchParams.set('$filter', filter)
  etaUrl.searchParams.set('$format', 'JSON')
  stopUrl.searchParams.set('$filter', filter)
  stopUrl.searchParams.set('$format', 'JSON')
  const [data, stops, routes] = await Promise.all([
    fetchTDXJson<BusETAItem[]>(env, etaUrl, ETA_CACHE_SECONDS),
    fetchTDXJson<StopItem[]>(env, stopUrl, STATIC_CACHE_SECONDS),
    getRouteCatalog(env, city),
  ])
  const nearbyStopUids = findNearbyStopUids(stops, anchorStopUid)
  const routeByUid = new Map(routes.filter((route) => route.routeUid).map((route) => [route.routeUid, route]))

  const suggestions = data
    .filter((item): item is BusETAItem & { StopUID: string; StopName: { Zh_tw: string }; Direction: Direction } =>
      Boolean(item.StopUID && item.StopName?.Zh_tw && item.RouteName?.Zh_tw)
      && (item.Direction === 0 || item.Direction === 1),
    )
    .filter((item) => nearbyStopUids.size === 0 || nearbyStopUids.has(item.StopUID))
    .map((item) => {
      const route = item.RouteUID ? routeByUid.get(item.RouteUID) : undefined
      const from = item.Direction === 0 ? route?.departure : route?.destination
      const to = item.Direction === 0 ? route?.destination : route?.departure
      return {
        city,
        routeName: item.RouteName?.Zh_tw ?? '未知路線',
        routeUid: item.RouteUID,
        stopName: item.StopName.Zh_tw,
        stopUid: item.StopUID,
        direction: item.Direction,
        directionLabel: from && to ? `${from} → ${to}` : '',
        label: formatETALabel(
          typeof item.EstimateTime === 'number' ? Math.ceil(Math.max(0, item.EstimateTime) / 60) : null,
          item.StopStatus ?? 0,
        ),
      }
    })

  return [...new Map(suggestions.map((item) => [
    `${item.routeUid ?? item.routeName}:${item.stopUid}:${item.direction}`,
    item,
  ])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
    // 前端會依「目前選擇、常搭、ETA」排序後再縮到可閱讀的數量。
    .slice(0, 40)
}

export async function getRouteDetail(env: TDXEnv, query: ResolvedBusQuery): Promise<RouteDetail> {
  const [groups, etaItems] = await Promise.all([
    getRouteStopGroups(env, query.city, query.routeName),
    getBusETA(env, query),
  ])
  const group = groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid),
  ) ?? groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  )

  if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
  const etaByStop = new Map(
    etaItems
      .filter((item) => item.Direction === query.direction && (!query.routeUid || item.RouteUID === query.routeUid))
      .filter((item): item is BusETAItem & { StopUID: string } => Boolean(item.StopUID))
      .map((item) => [item.StopUID, item]),
  )

  return {
    routeName: query.routeName,
    direction: query.direction,
    label: group.label,
    stops: group.stops.map((stop) => {
      const eta = etaByStop.get(stop.stopUid)
      return {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(
              typeof eta.EstimateTime === 'number' ? Math.ceil(Math.max(0, eta.EstimateTime) / 60) : null,
              eta.StopStatus ?? 0,
            )
          : null,
      }
    }),
  }
}

async function getBusETA(env: TDXEnv, query: BusQuery): Promise<BusETAItem[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/City/${encodeURIComponent(query.city)}/${encodeURIComponent(query.routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return fetchTDXJson<BusETAItem[]>(env, url, ETA_CACHE_SECONDS)
}

export async function fetchTDXJson<T>(env: TDXEnv, url: URL, ttlSeconds: number): Promise<T> {
  const edgeCache = (caches as CacheStorage & { default: Cache }).default
  const cacheKey = new Request(`https://mochi-cache.invalid/tdx/${encodeURIComponent(url.toString())}`)
  const cached = await edgeCache.match(cacheKey)
  if (cached) return await cached.json() as T

  const token = await getTDXToken(env)
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`TDX request failed (${response.status})`)

  const data = await response.json() as T
  await edgeCache.put(cacheKey, new Response(JSON.stringify(data), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': `public, max-age=${ttlSeconds}`,
    },
  }))
  return data
}

function dedupeStops(stops: RouteStop[]): RouteStop[] {
  return [...new Map(stops.map((stop) => [stop.stopUid, stop])).values()]
}

function findNearbyStopUids(stops: StopItem[], anchorStopUid?: string): Set<string> {
  if (!anchorStopUid) return new Set()
  const anchor = stops.find((stop) => stop.StopUID === anchorStopUid)?.StopPosition
  if (typeof anchor?.PositionLat !== 'number' || typeof anchor.PositionLon !== 'number') {
    return new Set([anchorStopUid])
  }

  return new Set(stops
    .filter((stop) => stop.StopUID && typeof stop.StopPosition?.PositionLat === 'number' && typeof stop.StopPosition.PositionLon === 'number')
    .filter((stop) => distanceMeters(
      anchor.PositionLat as number,
      anchor.PositionLon as number,
      stop.StopPosition?.PositionLat as number,
      stop.StopPosition?.PositionLon as number,
    ) <= 25)
    .map((stop) => stop.StopUID as string))
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6_371_000
  const toRadians = (degrees: number) => degrees * Math.PI / 180
  const deltaLat = toRadians(lat2 - lat1)
  const deltaLon = toRadians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

export function toETAResult(item: BusETAItem, query: ResolvedBusQuery, now = new Date()): ETAResult {
  const estimateSeconds = typeof item.EstimateTime === 'number'
    ? Math.max(0, item.EstimateTime)
    : null
  const minutes = estimateSeconds === null ? null : Math.ceil(estimateSeconds / 60)
  const stopStatus = item.StopStatus ?? 0
  const dataTime = item.DataTime ?? item.SrcUpdateTime ?? item.SrcTransTime ?? item.UpdateTime ?? null
  const dataTimestamp = dataTime ? new Date(dataTime).getTime() : Number.NaN

  return {
    routeName: query.routeName,
    stopName: item.StopName?.Zh_tw ?? query.stopName,
    stopUid: item.StopUID ?? query.stopUid,
    direction: item.Direction ?? query.direction,
    estimateSeconds,
    minutes,
    label: formatETALabel(minutes, stopStatus),
    stopStatus,
    statusLabel: estimateSeconds === null ? formatStopStatus(stopStatus) : '正常',
    dataTime,
    fetchedAt: now.toISOString(),
    stale: Number.isFinite(dataTimestamp) && now.getTime() - dataTimestamp > STALE_AFTER_MS,
  }
}

export function formatETALabel(minutes: number | null, stopStatus: number): string {
  if (minutes !== null) return minutes <= 1 ? '即將進站' : `${minutes} 分鐘`
  return formatStopStatus(stopStatus)
}

export function formatStopStatus(status: number): string {
  return ({
    0: '暫無預估時間',
    1: '尚未發車',
    2: '交管不停靠',
    3: '末班車已過',
    4: '今日未營運',
  } as Record<number, string>)[status] ?? '暫無資料'
}
