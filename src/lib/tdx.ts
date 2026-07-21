import type { BusQuery, Direction, ResolvedBusQuery } from '../domain/bus-query'
import { supportedCityCodes } from '../config'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem } from '../domain/schedule'
import { tdxWarningMessages, type TDXWarning } from '../domain/tdx-warning'
import { selectBestEta } from '../domain/map/eta'
import {
  routeEtaStateFromTdx,
  type RouteEtaPresentationState,
} from '../domain/route-eta-status'
import { selectRouteStopGroup } from '../domain/route-stop-group-selection'
import { getSnapshotSchedule, type TransitBindings } from '../infrastructure/transit/snapshot-repository'
import type { TelemetryCity } from '../observability/telemetry'
import {
  formatETALabel,
  toETAResult,
  type BusETAItem,
  type ETAResult,
} from './tdx/eta-formatting'
import {
  TDXServiceError,
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
  TDX_ERROR_MAX_RESPONSE_BYTES,
  TDXPayloadTooLargeError,
  logTDXResponseSize,
  logTDXResponseTooLarge,
  parsedContentLength,
  readJsonResponse,
  readTextResponse,
  type TDXBoundedTextResponse,
  type TDXResponseObservation,
} from './tdx/bounded-response'
import { createTDXUpstreamDataClient } from './tdx/upstream-data-client'
import {
  createTDXResolutionCache,
  withTDXBackgroundTasks,
  type TDXEnv,
  type TDXResolutionOptions,
  type TDXResolvedData,
} from './tdx/resolution-cache'
import {
  BUS_ETA_CACHE_SECONDS,
  QueryResolutionError,
  createTDXBusRouteQueries,
  tdxRouteScope,
} from './tdx/bus-route-queries'

export { formatETALabel, formatStopStatus, toETAResult } from './tdx/eta-formatting'
export type { BusETAItem, ETAResult } from './tdx/eta-formatting'
export {
  TDXServiceError,
  isRejectedUserTdxToken,
  resetTDXRateLimitTracking,
  tdxWarningFromError,
}
export { tdxCredentialScope, withUserTDXAccessToken } from './tdx/token-client'
export { withTDXBackgroundTasks }
export type { TDXEnv, TDXResolutionOptions, TDXResolvedData }
export {
  QueryResolutionError,
  mergeEquivalentStopGroups,
  tdxRouteScope,
} from './tdx/bus-route-queries'
export type {
  RouteCatalogItem,
  RouteStop,
  StopGroup,
  StopRouteSuggestion,
} from './tdx/bus-route-queries'

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

const REQUEST_TIMEOUT_MS = 6000
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


const resolutionCache = createTDXResolutionCache({
  getTDXToken,
  fetchUpstream: upstreamDataClient.fetchUpstream,
  recordCircuitFailure: (key, error) => circuitBreaker.recordFailure(key, error),
  recordCircuitSuccess: circuitBreaker.recordSuccess,
})

export const fetchTDXJson = resolutionCache.fetchTDXJson
export const resolveTDXJson = resolutionCache.resolveTDXJson


const busRouteQueries = createTDXBusRouteQueries({
  fetchTDXJson,
  telemetryCity,
})

export const resolveBusQuery = busRouteQueries.resolveBusQuery
export const getRouteStopGroups = busRouteQueries.getRouteStopGroups
export const getRouteCatalog = busRouteQueries.getRouteCatalog
export const getStopRouteSuggestions = busRouteQueries.getStopRouteSuggestions

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
  return fetchTDXJson<BusETAItem[]>(env, url, BUS_ETA_CACHE_SECONDS)
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
