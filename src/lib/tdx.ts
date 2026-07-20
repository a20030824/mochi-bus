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

type TDXTelemetryContext = {
  trafficClass?: TelemetryTrafficClass
  sampleProbability?: number
  now?: () => number
  random?: () => number
  emitter?: TelemetrySink
}

export type TDXEnv = {
  TDX_CLIENT_ID: string
  TDX_CLIENT_SECRET: string
  // 瀏覽器直接向 TDX 換取短效 token；Worker 永遠不接觸 Client Secret。
  TDX_USER_ACCESS_TOKEN?: string
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

type LocalizedName = {
  Zh_tw?: string
  En?: string
}

export type BusETAItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  SubRouteUID?: string
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
  // 即時 GPS 沒有預估時間時，會退回查時刻表；source 讓前端知道這是不是真的即時資料。
  source: 'realtime' | 'schedule' | 'none'
  warning?: TDXWarning
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

export class TDXServiceError extends Error {
  warning?: TDXWarning
  failureKind?: TelemetryFailureClass

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions & { failureKind?: TelemetryFailureClass },
  ) {
    super(message, options)
    this.name = 'TDXServiceError'
    this.failureKind = options?.failureKind
  }

  get rateLimited(): boolean {
    return this.status === 429 || this.warning === 'tdx-rate-limit' || this.warning === 'tdx-quota'
  }
}

export function isRejectedUserTdxToken(error: unknown, authorization?: string): boolean {
  return Boolean(authorization)
    && error instanceof TDXServiceError
    && error.status === 401
}

export { tdxWarningMessages }
export type { TDXWarning }

// 額度用完與頻率超限 TDX 都只回 429,單看狀態碼分不出來;但頻率超限幾秒就恢復、
// 額度用完會持續到月底。以「連續 429 撐了多久」區分該給使用者哪種說法:
// 只要中間有任何一次成功就歸零,所以尖峰時偶發的頻率 429 不會被誤判成額度用完。
// 只追蹤共用憑證的結果——使用者在 setup 頁測試或帶自己 TDX 憑證時撞到的 429
// 是他個人帳號的事,不能拿來污染「共用額度可能已用完」這句對所有人顯示的訊息。
let sharedRateLimitedSince: number | null = null
const QUOTA_SUSPECT_AFTER_MS = 10 * 60 * 1000

export function tdxWarningFromError(error: unknown): TDXWarning | undefined {
  if (!(error instanceof TDXServiceError)) return undefined
  if (error.warning) return error.warning
  if (!error.rateLimited) return 'tdx-unavailable'
  return sharedRateLimitedSince !== null && Date.now() - sharedRateLimitedSince >= QUOTA_SUSPECT_AFTER_MS
    ? 'tdx-quota'
    : 'tdx-rate-limit'
}

// 測試用:清掉跨測試殘留的 429 追蹤狀態。
export function resetTDXRateLimitTracking(): void {
  sharedRateLimitedSince = null
}

// TDX 的 429 body 會說明是頻率超限還是額度用盡,記進 log 供事後判讀;內容絕不回給使用者。
// isShared 只有共用憑證的請求才是 true,決定這次結果要不要更新額度追蹤狀態。
async function tdxResponseError(context: string, response: Response, isShared: boolean): Promise<TDXServiceError> {
  const body = await response.text().catch(() => '')
  const warning = classifyTDXWarning(response.status, body)
  if (isShared && (response.status === 429 || warning === 'tdx-rate-limit' || warning === 'tdx-quota')) {
    sharedRateLimitedSince ??= Date.now()
  }
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

function classifyTDXWarning(status: number, body: string): TDXWarning | undefined {
  const text = body.toLowerCase()
  const quotaLike = /quota|quotas|monthly|usage|額度|配額|用量|用完|用盡/.test(text)
    || (/exceed|exceeded|exceeds|超過|超出/.test(text) && /limit|limited|限制|上限/.test(text) && !/rate|frequency|頻率/.test(text))
    // 額度用完時 TDX 是整個 App 停權,連 token 端點都回標準 OAuth 錯誤(400 unauthorized_client/
    // invalid_client),不是文件假設的「先給 token、查詢時才擋 429」——這種換不到 token 也算額度用盡。
    || /unauthorized_client|invalid_client|invalid client credentials/.test(text)
  if (quotaLike) return 'tdx-quota'

  if (status !== 429 && /rate.?limit|too many requests|frequency|頻率|請求過多/.test(text)) {
    return 'tdx-rate-limit'
  }

  return undefined
}

type TokenCache = { value: string; expiresAt: number }
type CredentialSource = 'shared'
type CircuitState = {
  failures: number
  lastFailureAt: number
  openedUntil: number
  halfOpen: boolean
  warning: TDXWarning
}

// 共用憑證的 cache key 是 source + client_id + client_secret 的 SHA-256 指紋；
// Map 裡不保留原始 secret，同一 client_id 更換 secret 也不會誤用舊 token。
const tokenCache = new Map<string, TokenCache>()
const tdxCircuits = new Map<string, CircuitState>()

// 測試用：模擬 isolate 重建，避免模組層快取讓案例彼此污染。
export function resetTDXTestState(): void {
  sharedRateLimitedSince = null
  tokenCache.clear()
  tdxCircuits.clear()
}

const ETA_CACHE_SECONDS = 12
const STATIC_CACHE_SECONDS = 60 * 60
const STALE_AFTER_MS = 3 * 60 * 1000
const REQUEST_TIMEOUT_MS = 6000
const MAX_TOKEN_CACHE_ENTRIES = 128
const MAX_CIRCUIT_ENTRIES = 128
const CIRCUIT_FAILURE_THRESHOLD = 3
const CIRCUIT_FAILURE_WINDOW_MS = 60 * 1000
const TRANSIENT_CIRCUIT_OPEN_MS = 30 * 1000
const QUOTA_CIRCUIT_OPEN_MS = 5 * 60 * 1000
const MAX_RETRY_AFTER_MS = 5 * 60 * 1000
// 公路客運(公路總局)的資源掛在 /InterCity 底下,沒有 /City/{city} 路徑段;
// RouteUID 固定 THB 開頭。凡是「按路線」的即時/時刻表/站序/線形查詢都要據此換端點。
export function tdxRouteScope(city: string, routeUid?: string): string {
  return routeUid?.startsWith('THB') ? 'InterCity' : `City/${encodeURIComponent(city)}`
}

// isShared 標記這次拿到的 token 來自共用憑證還是使用者瀏覽器提供的短效 token,
// 讓呼叫端(fetchTDXJson)知道之後打 API 撞 429 時該不該算進共用額度追蹤。
export async function getTDXToken(env: TDXEnv): Promise<{ token: string; isShared: boolean; credentialKey: string }> {
  const userToken = env.TDX_USER_ACCESS_TOKEN
  if (userToken) {
    return {
      token: userToken,
      isShared: false,
      credentialKey: await accessTokenFingerprint(userToken),
    }
  }
  const sharedKey = await credentialFingerprint('shared', env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET)
  return {
    token: await tokenFor(env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET, sharedKey, true),
    isShared: true,
    credentialKey: sharedKey,
  }
}

function responseFailureClass(status: number, warning?: TDXWarning): TelemetryFailureClass {
  if (warning === 'tdx-quota') return 'quota'
  if (status === 429 || warning === 'tdx-rate-limit') return 'rate_limited'
  if (status === 401) return 'token_rejected'
  if (status >= 400 && status <= 499) return 'upstream_4xx'
  if (status >= 500 && status <= 599) return 'upstream_5xx'
  return 'unknown'
}

function transportFailureClass(error: unknown): TelemetryFailureClass {
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network_error'
}

async function accessTokenFingerprint(accessToken: string): Promise<string> {
  const input = new TextEncoder().encode(`user-token\0${accessToken}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function tdxCredentialScope(env: TDXEnv): Promise<string> {
  return env.TDX_USER_ACCESS_TOKEN
    ? `user/${await accessTokenFingerprint(env.TDX_USER_ACCESS_TOKEN)}`
    : 'shared'
}

async function credentialFingerprint(source: CredentialSource, clientId: string, clientSecret: string): Promise<string> {
  const input = new TextEncoder().encode(`${source}\0${clientId}\0${clientSecret}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cachedToken(key: string): string | undefined {
  const cached = tokenCache.get(key)
  if (!cached) return undefined
  if (cached.expiresAt <= Date.now()) {
    tokenCache.delete(key)
    return undefined
  }
  tokenCache.delete(key)
  tokenCache.set(key, cached)
  return cached.value
}

function cacheToken(key: string, entry: TokenCache): void {
  tokenCache.delete(key)
  tokenCache.set(key, entry)
  while (tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
    const oldestKey = tokenCache.keys().next().value
    if (oldestKey === undefined) break
    tokenCache.delete(oldestKey)
  }
}

function retryAfterMilliseconds(value: string | null, now: number): number | undefined {
  if (!value) return undefined
  const seconds = Number(value.trim())
  const milliseconds = Number.isFinite(seconds)
    ? seconds * 1000
    : Date.parse(value) - now
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return undefined
  return Math.min(Math.max(milliseconds, 1000), MAX_RETRY_AFTER_MS)
}

function cacheCircuit(key: string, state: CircuitState): void {
  tdxCircuits.delete(key)
  tdxCircuits.set(key, state)
  while (tdxCircuits.size > MAX_CIRCUIT_ENTRIES) {
    const oldestKey = tdxCircuits.keys().next().value
    if (oldestKey === undefined) break
    tdxCircuits.delete(oldestKey)
  }
}

function assertTDXCircuitClosed(key: string): boolean {
  const state = tdxCircuits.get(key)
  if (!state) return false

  const now = Date.now()
  if (state.openedUntil > now) {
    const error = new TDXServiceError(
      'TDX circuit breaker is open',
      state.warning === 'tdx-unavailable' ? 503 : 429,
      { failureKind: 'circuit_open' },
    )
    error.warning = state.warning
    throw error
  }

  if (state.halfOpen) {
    const error = new TDXServiceError(
      'TDX circuit breaker probe is in progress',
      state.warning === 'tdx-unavailable' ? 503 : 429,
      { failureKind: 'circuit_open' },
    )
    error.warning = state.warning
    throw error
  }

  if (state.openedUntil > 0) {
    // 冷卻結束後放行一次 half-open probe；若 probe 再失敗會立刻重新熔斷。
    cacheCircuit(key, {
      ...state,
      failures: CIRCUIT_FAILURE_THRESHOLD - 1,
      openedUntil: 0,
      halfOpen: true,
    })
    return true
  }
  if (now - state.lastFailureAt >= CIRCUIT_FAILURE_WINDOW_MS) tdxCircuits.delete(key)
  return false
}

function recordTDXCircuitFailure(key: string, error: TDXServiceError, retryAfter: string | null = null): void {
  const status = error.status
  const transient = status === undefined || status === 408 || (status >= 500 && status <= 599)
  if (!error.rateLimited && !transient) {
    recordTDXCircuitSuccess(key)
    return
  }

  const now = Date.now()
  const previous = tdxCircuits.get(key)
  const failures = previous?.halfOpen
    ? CIRCUIT_FAILURE_THRESHOLD
    : previous && now - previous.lastFailureAt < CIRCUIT_FAILURE_WINDOW_MS
      ? previous.failures + 1
      : 1
  const warning = error.warning ?? (error.rateLimited ? 'tdx-rate-limit' : 'tdx-unavailable')
  let openedUntil = 0
  if (error.rateLimited) {
    const openFor = warning === 'tdx-quota'
      ? QUOTA_CIRCUIT_OPEN_MS
      : retryAfterMilliseconds(retryAfter, now) ?? TRANSIENT_CIRCUIT_OPEN_MS
    openedUntil = now + openFor
  } else if (failures >= CIRCUIT_FAILURE_THRESHOLD) {
    openedUntil = now + TRANSIENT_CIRCUIT_OPEN_MS
  }

  cacheCircuit(key, { failures, lastFailureAt: now, openedUntil, halfOpen: false, warning })
  if (openedUntil > now && (!previous || previous.openedUntil <= now)) {
    console.error(JSON.stringify({
      message: 'tdx_circuit_opened',
      warning,
      openMs: openedUntil - now,
    }))
  }
}

function recordTDXCircuitSuccess(key: string): void {
  tdxCircuits.delete(key)
}

const tokenCircuitKey = (credentialKey: string) => `token/${credentialKey}`
const dataCircuitKey = (credentialKey: string) => `data/${credentialKey}`

async function tokenFor(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  isShared: boolean,
): Promise<string> {
  assertTDXCircuitClosed(tokenCircuitKey(credentialKey))
  const cached = cachedToken(credentialKey)
  if (cached) return cached
  return fetchTDXToken(clientId, clientSecret, credentialKey, isShared)
}

async function fetchTDXToken(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  isShared: boolean,
): Promise<string> {
  const circuitKey = tokenCircuitKey(credentialKey)
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
  })
  let response: Response
  try {
    response = await fetch(
      'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    )
  } catch (error) {
    const serviceError = new TDXServiceError('TDX token request failed', undefined, {
      cause: error,
      failureKind: transportFailureClass(error),
    })
    recordTDXCircuitFailure(circuitKey, serviceError)
    throw serviceError
  }

  if (!response.ok) {
    const error = await tdxResponseError('TDX token request failed', response, isShared)
    recordTDXCircuitFailure(circuitKey, error, response.headers.get('Retry-After'))
    throw error
  }
  if (isShared) sharedRateLimitedSince = null
  let data: { access_token?: string; expires_in?: number }
  try {
    data = await response.json() as { access_token?: string; expires_in?: number }
  } catch (error) {
    const serviceError = new TDXServiceError('TDX token response is invalid JSON', 502, {
      cause: error,
      failureKind: 'invalid_json',
    })
    recordTDXCircuitFailure(circuitKey, serviceError)
    throw serviceError
  }
  if (!data.access_token) {
    const error = new TDXServiceError('TDX token response is missing access_token', 502, {
      failureKind: 'invalid_schema',
    })
    recordTDXCircuitFailure(circuitKey, error)
    throw error
  }

  recordTDXCircuitSuccess(circuitKey)
  const expiresIn = Math.max(60, data.expires_in ?? 3600)
  cacheToken(credentialKey, {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
  })
  return data.access_token
}

export function withUserTDXAccessToken<E extends TDXEnv>(env: E, accessToken?: string | null): E {
  if (!accessToken) return env
  return { ...env, TDX_USER_ACCESS_TOKEN: accessToken }
}

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
  const maxResponseBytes = normalizedResponseByteLimit(options.maxResponseBytes)
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
      const data = await readJsonResponse(cached, maxResponseBytes)
      if (validPayload(data, options.validate)) {
        const cachedAt = parsedCacheTimestamp(cached.headers.get('X-Mochi-Cached-At'))
        const typed = data as T
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
  const circuitKey = dataCircuitKey(credentialKey)
  try {
    assertTDXCircuitClosed(circuitKey)
  } catch (error) {
    return finishFailure(asTDXServiceError(error), false)
  }

  while (true) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const serviceError = new TDXServiceError('TDX request failed', undefined, {
        cause: error,
        failureKind: transportFailureClass(error),
      })
      if (shouldRetryResolution(serviceError, options.operation, retryCount)) {
        retryCount += 1
        initialFailureClass = serviceError.failureKind
        continue
      }
      recordTDXCircuitFailure(circuitKey, serviceError)
      return finishFailure(serviceError, true)
    }
    if (!response.ok) {
      const error = await tdxResponseError('TDX request failed', response, isShared)
      if (shouldRetryResolution(error, options.operation, retryCount)) {
        retryCount += 1
        initialFailureClass = error.failureKind
        continue
      }
      recordTDXCircuitFailure(circuitKey, error, response.headers.get('Retry-After'))
      return finishFailure(error, true)
    }
    if (isShared) sharedRateLimitedSince = null

    let unvalidated: unknown
    try {
      unvalidated = await readJsonResponse(response, maxResponseBytes)
    } catch (error) {
      const serviceError = error instanceof TDXPayloadTooLargeError
        ? error
        : new TDXServiceError('TDX response is invalid JSON', 502, {
            cause: error,
            failureKind: 'invalid_json',
          })
      if (serviceError instanceof TDXPayloadTooLargeError) {
        recordTDXCircuitSuccess(circuitKey)
        console.error(JSON.stringify({
          message: 'tdx_response_too_large',
          maxBytes: serviceError.maxBytes,
          receivedBytes: serviceError.receivedBytes ?? null,
        }))
      } else {
        recordTDXCircuitFailure(circuitKey, serviceError)
      }
      return finishFailure(serviceError, true)
    }
    if (!validPayload(unvalidated, options.validate)) {
      const serviceError = new TDXServiceError('TDX response has an invalid schema', 502, {
        failureKind: 'invalid_schema',
      })
      recordTDXCircuitFailure(circuitKey, serviceError)
      return finishFailure(serviceError, true)
    }

    const data = unvalidated as T
    recordTDXCircuitSuccess(circuitKey)
    const cachedAt = now()
    memoryCacheSet(memoryKey, { data, cachedAt }, ttlSeconds)
    const resolved = completeData(data, 'upstream', 0, response.status)
    await cachePutFailOpen(edgeCache, cacheKey, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
        'X-Mochi-Cached-At': String(cachedAt),
      },
    }), 'tdx', env.TDX_BACKGROUND_TASKS)
    return resolved
  }
}

class TDXPayloadTooLargeError extends TDXServiceError {
  constructor(
    readonly maxBytes: number,
    readonly receivedBytes?: number,
  ) {
    super('TDX response exceeds configured byte limit', 502, {
      failureKind: 'invalid_schema',
    })
    this.name = 'TDXPayloadTooLargeError'
  }
}

function normalizedResponseByteLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

async function readJsonResponse(response: Response, maxBytes?: number): Promise<unknown> {
  if (maxBytes === undefined) return response.json()

  const declaredLength = parsedContentLength(response.headers.get('Content-Length'))
  if (declaredLength !== undefined && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new TDXPayloadTooLargeError(maxBytes, declaredLength)
  }
  if (!response.body) return response.json()

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      receivedBytes += value.byteLength
      if (receivedBytes > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new TDXPayloadTooLargeError(maxBytes, receivedBytes)
      }
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
  } finally {
    reader.releaseLock()
  }
  return JSON.parse(body)
}

function parsedContentLength(value: string | null): number | undefined {
  if (!value) return undefined
  const length = Number(value)
  return Number.isFinite(length) && length >= 0 ? length : undefined
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

function shouldRetryResolution(
  error: TDXServiceError,
  operation: TelemetryTdxOperation | undefined,
  retryCount: number,
): boolean {
  return Boolean(operation)
    && retryCount === 0
    && (error.failureKind === 'timeout'
      || error.failureKind === 'network_error'
      || error.failureKind === 'upstream_5xx')
}

function asTDXServiceError(error: unknown): TDXServiceError {
  if (error instanceof TDXServiceError) return error
  return new TDXServiceError('TDX resolution failed', undefined, {
    cause: error,
    failureKind: 'unknown',
  })
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
    source: estimateSeconds === null ? 'none' : 'realtime',
  }
}

export function formatETALabel(minutes: number | null, stopStatus: number): string {
  if (minutes !== null) return minutes <= 1 ? '即將進站' : `${minutes} 分`
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
