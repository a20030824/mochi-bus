import type { BusQuery, Direction, ResolvedBusQuery } from '../domain/bus-query'
import { supportedCityCodes } from '../config'
import { classifyRouteName, type RouteCategory } from '../domain/route-category'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem } from '../domain/schedule'
import { tdxWarningMessages, type TDXWarning } from '../domain/tdx-warning'
import { selectBestEta } from '../domain/map/eta'
import {
  routeEtaStateFromTdx,
  type RouteEtaPresentationState,
} from '../domain/route-eta-status'
import { selectRouteStopGroup } from '../domain/route-stop-group-selection'
import { getSnapshotSchedule, type TransitBindings } from '../infrastructure/transit/snapshot-repository'
import { memoryCacheGet, memoryCacheSet } from './memory-cache'
import { cacheMatchFailOpen, cachePutFailOpen, type BackgroundTaskScheduler } from './edge-cache'
import { releaseIdentity } from '../observability/release-identity'
import { beginTDXResolutionTelemetry } from '../observability/tdx-resolution'
import type {
  TelemetryCity,
  TelemetryFailureClass,
  TelemetrySink,
  TelemetryTdxOperation,
  TelemetryTrafficClass,
} from '../observability/telemetry'
import {
  formatETALabel,
  toETAResult,
  type BusETAItem,
  type ETAResult,
  type LocalizedName,
} from './tdx/eta-formatting'
import {
  TDXServiceError,
  asTDXServiceError,
  classifyTDXWarning,
  isRejectedUserTdxToken,
  observeTDXResponseFailure,
  resetTDXRateLimitTracking,
  responseFailureClass,
  tdxWarningFromError,
} from './tdx/error-classification'
import {
  createTDXTokenClient,
  tdxCredentialScope,
  withUserTDXAccessToken,
  type TDXCredentialEnv,
} from './tdx/token-client'
import {
  createTDXCircuitBreaker,
} from './tdx/circuit-breaker'
import {
  DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES,
  TDX_ERROR_MAX_RESPONSE_BYTES,
  TDXPayloadTooLargeError,
  logTDXResponseSize,
  logTDXResponseTooLarge,
  parsedContentLength,
  readJsonResponse,
  readTextResponse,
  responseByteLimit,
  type TDXBoundedTextResponse,
  type TDXResponseObservation,
} from './tdx/bounded-response'
import { createTDXUpstreamDataClient } from './tdx/upstream-data-client'

export { formatETALabel, formatStopStatus, toETAResult } from './tdx/eta-formatting'
export type { BusETAItem, ETAResult } from './tdx/eta-formatting'
export {
  TDXServiceError,
  isRejectedUserTdxToken,
  resetTDXRateLimitTracking,
  tdxWarningFromError,
}
export { tdxCredentialScope, withUserTDXAccessToken } from './tdx/token-client'

type TDXTelemetryContext = {
  trafficClass?: TelemetryTrafficClass
  sampleProbability?: number
  now?: () => number
  random?: () => number
  emitter?: TelemetrySink
}

export type TDXEnv = TDXCredentialEnv & {
  TDX_BACKGROUND_TASKS?: BackgroundTaskScheduler
  CF_VERSION_METADATA?: CloudflareBindings['CF_VERSION_METADATA']
  TDX_TELEMETRY?: TDXTelemetryContext
}

export type TDXResolutionOptions<T> = {
  operation?: TelemetryTdxOperation
  city?: TelemetryCity | null
  validate?: (value: unknown) => value is T
  staleFallback?: (error: TDXServiceError) => Promise<{ data: T; dataAgeMilliseconds?: number } | undefined>
  blockedFailureClass?: TelemetryFailureClass
  maxResponseBytes?: number
}

export type TDXResolvedData<T> = {
  data: T
  resolution: 'memory' | 'edge' | 'upstream' | 'stale_replay'
  degraded: boolean
}

export function withTDXBackgroundTasks<E extends TDXEnv>(env: E, schedule?: BackgroundTaskScheduler): E {
  return schedule ? { ...env, TDX_BACKGROUND_TASKS: schedule } : env
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

export type StopRouteSuggestion = ResolvedBusQuery & {
  label: string
  directionLabel: string
}

// 「estimated 淡墨」保留給未來的時刻表 fallback;目前 Route 只查即時 ETA,
// 空白不可解讀為已過站(可能是缺漏、支線對應或尚未發車)。
export type RouteEtaTone = 'live' | 'urgent' | 'muted'

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
    etaTone: RouteEtaTone
  }>
}

export type RouteDetailWithEtaStates = {
  detail: RouteDetail
  states: RouteEtaPresentationState[]
}

export class QueryResolutionError extends Error {
  constructor(message: string, readonly candidates: RouteStop[] = []) {
    super(message)
    this.name = 'QueryResolutionError'
  }
}

export { tdxWarningMessages }
export type { TDXWarning }

// TDX 的 429 body 會說明是頻率超限還是額度用盡,記進 log 供事後判讀;內容絕不回給使用者。
// isShared 只有共用憑證的請求才是 true,決定這次結果要不要更新額度追蹤狀態。
async function tdxResponseError(
  context: string,
  response: Response,
  isShared: boolean,
  observation: Pick<TDXResponseObservation, 'operation' | 'resource'>,
): Promise<TDXServiceError> {
  const body: TDXBoundedTextResponse = await readTextResponse(
    response,
    TDX_ERROR_MAX_RESPONSE_BYTES,
    true,
  ).catch((): TDXBoundedTextResponse => ({
    text: '',
    receivedBytes: 0,
    declaredBytes: parsedContentLength(response.headers.get('Content-Length')),
    truncated: false,
  }))
  if (body.truncated) {
    console.error(JSON.stringify({
      message: 'tdx_error_body_truncated',
      operation: observation.operation ?? 'unclassified',
      resource: observation.resource,
      credentialScope: isShared ? 'shared' : 'byok',
      status: response.status,
      maxBytes: TDX_ERROR_MAX_RESPONSE_BYTES,
      receivedBytes: body.receivedBytes,
      declaredBytes: body.declaredBytes ?? null,
      sizeSource: body.limitSource ?? 'stream',
    }))
  }
  const warning = classifyTDXWarning(response.status, body.text)
  observeTDXResponseFailure(response.status, warning, isShared)
  console.error(JSON.stringify({
    message: 'tdx_upstream_error',
    context,
    status: response.status,
  }))
  const error = new TDXServiceError(`${context} (${response.status})`, response.status, {
    failureKind: responseFailureClass(response.status, warning),
  })
  error.warning = warning
  return error
}

// 測試用：模擬 isolate 重建，避免模組層快取讓案例彼此污染。
export function resetTDXTestState(): void {
  resetTDXRateLimitTracking()
  resetTDXTokenState()
  circuitBreaker.reset()
  upstreamDataClient.resetTDXUpstreamState()
}

const ETA_CACHE_SECONDS = 12
const STATIC_CACHE_SECONDS = 60 * 60
const REQUEST_TIMEOUT_MS = 6000
// 公路客運(公路總局)的資源掛在 /InterCity 底下,沒有 /City/{city} 路徑段;
// RouteUID 固定 THB 開頭。凡是「按路線」的即時/時刻表/站序/線形查詢都要據此換端點。
export function tdxRouteScope(city: string, routeUid?: string): string {
  return routeUid?.startsWith('THB') ? 'InterCity' : `City/${encodeURIComponent(city)}`
}

const circuitBreaker = createTDXCircuitBreaker({
  onOpened: ({ warning, openMs }) => {
    console.error(JSON.stringify({
      message: 'tdx_circuit_opened',
      warning,
      openMs,
    }))
  },
})

const tokenClient = createTDXTokenClient({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  assertCircuitClosed: (key) => { circuitBreaker.assertClosed(key) },
  recordCircuitFailure: (key, error, retryAfter) => circuitBreaker.recordFailure(key, error, retryAfter),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
  responseError: (context, response, isShared, observation) => (
    tdxResponseError(context, response, isShared, observation)
  ),
  readJsonResponse,
  isPayloadTooLargeError: (error): error is TDXServiceError => error instanceof TDXPayloadTooLargeError,
  logResponseTooLarge: (error, observation) => (
    logTDXResponseTooLarge(error as TDXPayloadTooLargeError, observation)
  ),
  logResponseSize: logTDXResponseSize,
})

export const getTDXToken = tokenClient.getTDXToken
const resetTDXTokenState = tokenClient.resetTDXTokenState


const upstreamDataClient = createTDXUpstreamDataClient({
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  assertCircuitClosed: (key) => { circuitBreaker.assertClosed(key) },
  recordCircuitFailure: (key, error, retryAfter) => circuitBreaker.recordFailure(key, error, retryAfter),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
  responseError: (context, response, isShared, observation) => (
    tdxResponseError(context, response, isShared, observation)
  ),
})

export async function resolveBusQuery(env: TDXEnv, query: BusQuery): Promise<ResolvedBusQuery> {
  const groups = await getRouteStopGroups(env, query.city, query.routeName, query.routeUid)
  const candidates = groups
    .flatMap((group) => group.stops)
    .filter((stop) => stop.direction === query.direction)
    .filter((stop) => query.stopUid
      ? stop.stopUid === query.stopUid
      : stop.stopName === query.stopName)
    // 同一站牌可能有多條支線共用同一個 stopUid(例如共站的幹線與支線變體)；
    // 有 subRouteUid 時用它排除其他支線，避免撞到錯誤的班次。
    .filter((stop) => !query.subRouteUid || stop.subRouteUid === query.subRouteUid)

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
    subRouteUid: query.subRouteUid ?? match.subRouteUid,
    stopUid: match.stopUid,
    stopName: match.stopName,
  }
}

export async function getCommuteETA(env: TDXEnv & Partial<TransitBindings>, query: ResolvedBusQuery): Promise<ETAResult> {
  let items: BusETAItem[] = []
  let warning: TDXWarning | undefined
  try {
    items = await getBusETA(env, query)
  } catch (error) {
    if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
    warning = tdxWarningFromError(error)
    console.error(JSON.stringify({
      message: 'commute_eta_realtime_failed',
      city: query.city,
      routeName: query.routeName,
      error: error instanceof Error ? error.message : String(error),
    }))
  }
  const item = selectBestEta(items, {
    routeUid: query.routeUid,
    stopUid: query.stopUid,
    direction: query.direction,
    subRouteUid: query.subRouteUid,
  })
  // 完全沒有即時資料時給一個空 item,讓時刻表 fallback 有機會接手;
  // 不放 DataTime,dataTime 保持 null 才不會看起來像有新鮮的即時資料。
  const result = toETAResult(item ?? {
    StopUID: query.stopUid,
    Direction: query.direction,
    StopStatus: 0,
  }, query)
  if (result.minutes !== null) return warning ? { ...result, warning } : result

  // 即時資料沒有預估時間(尚未發車／資料中斷)時，退回查時刻表，避免小型客運業者
  // 即時回報不穩定時整面板一直卡在「暫無資料」。
  try {
    const schedules = env.TRANSIT_DB && env.TRANSIT_SHAPES
      ? await getSnapshotSchedule(env as TDXEnv & TransitBindings, query.city, query.routeName, query.routeUid)
        ?? await getBusSchedule(env, query.city, query.routeName, query.routeUid)
      : await getBusSchedule(env, query.city, query.routeName, query.routeUid)
    const now = new Date()
    const estimate = nextScheduledMinutes(schedules, {
      stopUid: query.stopUid, direction: query.direction, subRouteUid: query.subRouteUid,
    }, now)
    if (estimate === null) return result
    return {
      ...result,
      minutes: estimate.minutes,
      estimateSeconds: estimate.minutes * 60,
      // 發車時間估計是下限(車還要從起點開過來),標示成「發車」避免誤導成到站時間
      label: estimate.headwayMinutes
        ? `${estimate.headwayMinutes[0]}–${estimate.headwayMinutes[1]} 分一班`
        : scheduleClockLabel(estimate, now)
          ?? (estimate.departureBased
            ? `${Math.max(1, estimate.minutes)} 分後發車`
            : formatETALabel(estimate.minutes, result.stopStatus)),
      statusLabel: estimate.headwayMinutes
        ? '班距預估'
        : estimate.nextDay
          ? '今日已收班'
          : estimate.departureBased ? '時刻表發車預估' : '時刻表預估',
      source: 'schedule',
      warning,
    }
  } catch (error) {
    if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
    warning ??= tdxWarningFromError(error)
    console.error('eta_schedule_fallback_failed', error)
    return warning ? { ...result, warning } : result
  }
}

export async function getBusSchedule(env: TDXEnv, city: string, routeName: string, routeUid?: string): Promise<ScheduleItem[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/Schedule/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return fetchTDXJson<ScheduleItem[]>(env, url, 6 * 60 * 60, {
    operation: 'tdx_schedule',
    city: telemetryCity(city),
    validate: isRecordArrayPayload,
  })
}

export async function getRouteStopGroups(
  env: TDXEnv,
  city: string,
  routeName: string,
  routeUid?: string,
): Promise<StopGroup[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/${tdxRouteScope(city, routeUid)}/${encodeURIComponent(routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  let data = await fetchTDXJson<StopOfRouteItem[]>(env, url, STATIC_CACHE_SECONDS)
  // 沒有 routeUid 可判斷(setup 選單只傳路名)而市區端點查不到時,退去公路客運端點找:
  // 快照目錄裡的 THB 路線得靠這個 fallback 拿到站序。
  if (!data.length && !routeUid) {
    const intercityUrl = new URL(
      `https://tdx.transportdata.tw/api/basic/v2/Bus/StopOfRoute/InterCity/${encodeURIComponent(routeName)}`,
    )
    intercityUrl.searchParams.set('$format', 'JSON')
    data = await fetchTDXJson<StopOfRouteItem[]>(env, intercityUrl, STATIC_CACHE_SECONDS)
  }

  const groups = data
    .filter((item): item is StopOfRouteItem & { Direction: Direction } =>
      item.Direction === 0 || item.Direction === 1 || item.Direction === 2,
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
    // 相同站序不代表相同支線；RouteUID/SubRouteUID 不同時必須保留為獨立選項。
    const signature = [
      group.routeUid ?? '',
      group.subRouteUid ?? '',
      group.direction,
      group.stops.map((stop) => stop.stopName).join('>'),
    ].join(':')
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
  const data = await fetchTDXJson<RouteItem[]>(env, url, STATIC_CACHE_SECONDS, {
    operation: 'route_catalog',
    city: telemetryCity(city),
    validate: isRecordArrayPayload,
  })

  const routes = data
    .filter((item): item is RouteItem & { RouteName: { Zh_tw: string } } => Boolean(item.RouteName?.Zh_tw))
    .map((item) => ({
      routeUid: item.RouteUID,
      routeName: item.RouteName.Zh_tw,
      departure: item.DepartureStopNameZh,
      destination: item.DestinationStopNameZh,
      category: classifyRouteName(item.RouteName.Zh_tw, item.RouteUID),
    }))

  return [...new Map(routes.map((route) => [
    route.routeUid ?? `${route.routeName}:${route.departure ?? ''}:${route.destination ?? ''}`,
    route,
  ])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true })
      || (a.routeUid ?? '').localeCompare(b.routeUid ?? ''))
}

// 公路客運全目錄(約 500 條、全台一份)。只取方向標籤用得到的欄位,$select 之後
// 回應只剩幾十 KB,照靜態資料的節奏快取。
async function getIntercityRouteCatalog(env: TDXEnv): Promise<RouteCatalogItem[]> {
  const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/InterCity')
  url.searchParams.set('$select', 'RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh')
  url.searchParams.set('$format', 'JSON')
  const data = await fetchTDXJson<RouteItem[]>(env, url, STATIC_CACHE_SECONDS, {
    operation: 'route_catalog',
    city: null,
    validate: isRecordArrayPayload,
  })
  return data
    .filter((item): item is RouteItem & { RouteName: { Zh_tw: string } } => Boolean(item.RouteName?.Zh_tw))
    .map((item) => ({
      routeUid: item.RouteUID,
      routeName: item.RouteName.Zh_tw,
      departure: item.DepartureStopNameZh,
      destination: item.DestinationStopNameZh,
      category: classifyRouteName(item.RouteName.Zh_tw, item.RouteUID),
    }))
}

export async function getStopRouteSuggestions(
  env: TDXEnv,
  city: string,
  stopName: string,
  anchorStopUid?: string,
): Promise<StopRouteSuggestion[]> {
  const filter = `StopName/Zh_tw eq '${stopName.replaceAll("'", "''")}'`
  const filteredUrl = (path: string) => {
    const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/${path}`)
    url.searchParams.set('$filter', filter)
    url.searchParams.set('$format', 'JSON')
    return url
  }
  // 公路客運跟市區公車常共用同名站牌,同站建議要兩邊都查;
  // 公路客運那側失敗只影響客運建議,不拖垮市區結果。
  const [data, stops, routes, intercityEta, intercityStops, intercityRoutes] = await Promise.all([
    fetchTDXJson<BusETAItem[]>(env, filteredUrl(`EstimatedTimeOfArrival/City/${encodeURIComponent(city)}`), ETA_CACHE_SECONDS),
    fetchTDXJson<StopItem[]>(env, filteredUrl(`Stop/City/${encodeURIComponent(city)}`), STATIC_CACHE_SECONDS),
    getRouteCatalog(env, city),
    fetchTDXJson<BusETAItem[]>(env, filteredUrl('EstimatedTimeOfArrival/InterCity'), ETA_CACHE_SECONDS).catch(() => [] as BusETAItem[]),
    fetchTDXJson<StopItem[]>(env, filteredUrl('Stop/InterCity'), STATIC_CACHE_SECONDS).catch(() => [] as StopItem[]),
    getIntercityRouteCatalog(env).catch(() => [] as RouteCatalogItem[]),
  ])
  const nearbyStopUids = findNearbyStopUids([...stops, ...intercityStops], anchorStopUid)
  const routeByUid = new Map([...routes, ...intercityRoutes]
    .filter((route) => route.routeUid).map((route) => [route.routeUid, route]))

  const suggestions = [...data, ...intercityEta]
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
        subRouteUid: item.SubRouteUID,
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
    `${item.routeUid ?? item.routeName}:${item.subRouteUid ?? ''}:${item.stopUid}:${item.direction}`,
    item,
  ])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
    // 前端會依「目前選擇、常搭、ETA」排序後再縮到可閱讀的數量。
    .slice(0, 40)
}

export async function getRouteDetail(
  env: TDXEnv,
  query: ResolvedBusQuery,
): Promise<RouteDetailWithEtaStates> {
  const [groups, etaItems] = await Promise.all([
    getRouteStopGroups(env, query.city, query.routeName, query.routeUid),
    getBusETA(env, query),
  ])
  const group = selectRouteStopGroup(groups, query)

  if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
  const stopUids = new Set(group.stops.map((stop) => stop.stopUid))
  const etaByStop = new Map([...stopUids].map((stopUid) => [
    stopUid,
    selectBestEta(etaItems, {
      routeUid: query.routeUid,
      subRouteUid: query.subRouteUid ?? group.subRouteUid,
      stopUid,
      direction: query.direction,
    }),
  ]))
  const timeline = group.stops.map((stop) => {
    const eta = etaByStop.get(stop.stopUid)
    const seconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
    return {
      stop: {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(seconds === null ? null : Math.ceil(seconds / 60), eta.StopStatus ?? 0)
          : null,
        etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteEtaTone,
      },
      state: routeEtaStateFromTdx({
        hasRealtimeRecord: Boolean(eta),
        estimateSeconds: seconds,
        stopStatus: eta?.StopStatus,
      }),
    }
  })

  return {
    detail: {
      routeName: query.routeName,
      direction: query.direction,
      label: group.label,
      stops: timeline.map((row) => row.stop),
    },
    states: timeline.map((row) => row.state),
  }
}

async function getBusETA(env: TDXEnv, query: BusQuery): Promise<BusETAItem[]> {
  const url = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${tdxRouteScope(query.city, query.routeUid)}/${encodeURIComponent(query.routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return fetchTDXJson<BusETAItem[]>(env, url, ETA_CACHE_SECONDS)
}

type TDXCacheEntry<T> = { data: T; cachedAt?: number }

export async function fetchTDXJson<T>(
  env: TDXEnv,
  url: URL,
  ttlSeconds: number,
  options: TDXResolutionOptions<T> = {},
): Promise<T> {
  return (await resolveTDXJson(env, url, ttlSeconds, options)).data
}

export async function resolveTDXJson<T>(
  env: TDXEnv,
  url: URL,
  ttlSeconds: number,
  options: TDXResolutionOptions<T> = {},
): Promise<TDXResolvedData<T>> {
  const now = telemetryNow(env)
  const maxResponseBytes = responseByteLimit(options.maxResponseBytes)
  const credentialScope = env.TDX_USER_ACCESS_TOKEN ? 'byok' as const : 'shared' as const
  const tracker = options.operation ? beginTDXResolutionTelemetry({
    tdxOperation: options.operation,
    credentialScope,
    city: options.city ?? null,
    trafficClass: env.TDX_TELEMETRY?.trafficClass ?? 'user',
    releaseIdentity: releaseIdentity(env.CF_VERSION_METADATA),
    sampleProbability: env.TDX_TELEMETRY?.sampleProbability,
    now: env.TDX_TELEMETRY?.now,
    random: env.TDX_TELEMETRY?.random,
    emitter: env.TDX_TELEMETRY?.emitter,
  }) : undefined
  let retryCount = 0
  let initialFailureClass: TelemetryFailureClass | undefined

  const completeData = (
    data: T,
    resolution: TDXResolvedData<T>['resolution'],
    dataAgeMilliseconds: number | undefined,
    upstreamStatus?: number,
  ): TDXResolvedData<T> => {
    tracker?.complete({
      resolution,
      result: isEmptyPayload(data) ? 'empty' : resolution === 'stale_replay' ? 'degraded' : 'success',
      failureClass: resolution === 'stale_replay' ? initialFailureClass ?? 'unknown' : 'none',
      initialFailureClass,
      retryCount,
      dataAgeMilliseconds,
      upstreamStatus,
    })
    return { data, resolution, degraded: resolution === 'stale_replay' }
  }

  const finishFailure = async (
    error: TDXServiceError,
    attemptedUpstream: boolean,
  ): Promise<TDXResolvedData<T>> => {
    const failureClass = error.failureKind ?? 'unknown'
    if (options.staleFallback) {
      try {
        const stale = await options.staleFallback(error)
        if (stale !== undefined && !isEmptyPayload(stale.data)) {
          initialFailureClass ??= failureClass
          return completeData(
            stale.data,
            'stale_replay',
            stale.dataAgeMilliseconds,
            attemptedUpstream ? error.status : undefined,
          )
        }
      } catch {
        // Stale fallback is fail-open for the original TDX failure; it never replaces the cause.
      }
    }
    tracker?.complete({
      resolution: failureClass === 'circuit_open' ? 'circuit_open' : attemptedUpstream ? 'upstream' : 'none',
      result: 'error',
      failureClass,
      initialFailureClass,
      retryCount,
      dataAgeMilliseconds: null,
      upstreamStatus: attemptedUpstream ? error.status : undefined,
    })
    throw error
  }

  const memoryKey = `tdx/${maxResponseBytes ?? 'unbounded'}/${url.toString()}`
  const memoized = memoryCacheGet<TDXCacheEntry<T>>(memoryKey)
  if (memoized !== undefined && validPayload(memoized.data, options.validate)) {
    return completeData(
      memoized.data,
      'memory',
      memoized.cachedAt === undefined ? undefined : Math.max(0, now() - memoized.cachedAt),
    )
  }

  const edgeCache = (caches as CacheStorage & { default: Cache }).default
  const cacheKey = new Request(`https://mochi-cache.invalid/tdx/${encodeURIComponent(url.toString())}`)
  const cached = await cacheMatchFailOpen(edgeCache, cacheKey, 'tdx')
  if (cached) {
    try {
      const parsed = await readJsonResponse(cached, maxResponseBytes)
      if (validPayload(parsed.data, options.validate)) {
        const cachedAt = parsedCacheTimestamp(cached.headers.get('X-Mochi-Cached-At'))
        const typed = parsed.data as T
        memoryCacheSet(memoryKey, { data: typed, cachedAt }, ttlSeconds)
        return completeData(
          typed,
          'edge',
          cachedAt === undefined ? undefined : Math.max(0, now() - cachedAt),
        )
      }
      console.error(JSON.stringify({ message: 'edge_cache_payload_invalid', context: 'tdx_schema' }))
    } catch (error) {
      console.error(JSON.stringify({
        message: 'edge_cache_payload_invalid',
        context: 'tdx',
        error: error instanceof Error ? error.message : String(error),
      }))
    }
  }

  if (options.blockedFailureClass) {
    const error = new TDXServiceError('TDX resolution blocked by active cooldown', 429, {
      failureKind: options.blockedFailureClass,
    })
    error.warning = options.blockedFailureClass === 'quota' ? 'tdx-quota' : 'tdx-rate-limit'
    return finishFailure(error, false)
  }

  let tokenInfo: Awaited<ReturnType<typeof getTDXToken>>
  try {
    tokenInfo = await getTDXToken(env)
  } catch (error) {
    const serviceError = asTDXServiceError(error)
    return finishFailure(
      serviceError,
      serviceError.failureKind !== 'circuit_open' && serviceError.failureKind !== 'unknown',
    )
  }
  const { token, isShared, credentialKey } = tokenInfo
  let upstreamResult: Awaited<ReturnType<typeof upstreamDataClient.fetchUpstream>>
  try {
    upstreamResult = await upstreamDataClient.fetchUpstream({
      url,
      maxResponseBytes,
      operation: options.operation,
      token,
      isShared,
      credentialKey,
      ttlSeconds,
      validatesPayload: Boolean(options.validate),
    })
  } catch (error) {
    return finishFailure(asTDXServiceError(error), false)
  }
  const { outcome: upstream, leader, circuitKey, resource } = upstreamResult
  retryCount = upstream.retryCount
  initialFailureClass = upstream.initialFailureClass
  if (!upstream.ok) return finishFailure(upstream.error, true)

  if (leader) {
    logTDXResponseSize({
      operation: options.operation,
      resource,
      credentialScope,
      maxBytes: maxResponseBytes,
      receivedBytes: upstream.receivedBytes,
      declaredBytes: upstream.declaredBytes,
      sampled: tracker?.isSampled ?? false,
    })
  }

  if (!validPayload(upstream.data, options.validate)) {
    const serviceError = new TDXServiceError('TDX response has an invalid schema', 502, {
      failureKind: 'invalid_schema',
    })
    if (leader) circuitBreaker.recordFailure(circuitKey, serviceError)
    return finishFailure(serviceError, true)
  }

  const data = upstream.data as T
  if (leader) circuitBreaker.recordSuccess(circuitKey)
  const cachedAt = now()
  memoryCacheSet(memoryKey, { data, cachedAt }, ttlSeconds)
  const resolved = completeData(data, 'upstream', 0, upstream.status)
  if (leader) {
    await cachePutFailOpen(edgeCache, cacheKey, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
        'X-Mochi-Cached-At': String(cachedAt),
      },
    }), 'tdx', env.TDX_BACKGROUND_TASKS)
  }
  return resolved
}

function validPayload<T>(value: unknown, validate?: (value: unknown) => value is T): value is T {
  return validate ? validate(value) : true
}

export function isTDXRecordArray<T extends object>(value: unknown): value is T[] {
  return isRecordArrayPayload(value)
}

function isRecordArrayPayload<T extends object>(value: unknown): value is T[] {
  return Array.isArray(value)
    && value.every((item) => item !== null && typeof item === 'object' && !Array.isArray(item))
}

function telemetryCity(value: string): TelemetryCity | null {
  return supportedCityCodes.has(value) ? value as TelemetryCity : null
}

function isEmptyPayload(value: unknown): boolean {
  return Array.isArray(value) && value.length === 0
}

function parsedCacheTimestamp(value: string | null): number | undefined {
  if (!value) return undefined
  const timestamp = Number(value)
  return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp : undefined
}

function telemetryNow(env: TDXEnv): () => number {
  const configured = env.TDX_TELEMETRY?.now
  return () => {
    try {
      const value = configured ? configured() : Date.now()
      return Number.isFinite(value) ? value : Date.now()
    } catch {
      return Date.now()
    }
  }
}

function dedupeStops(stops: RouteStop[]): RouteStop[] {
  return [...new Map(stops.map((stop) => [[
    stop.routeUid ?? '',
    stop.subRouteUid ?? '',
    stop.direction,
    stop.stopUid,
  ].join(':'), stop])).values()]
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
