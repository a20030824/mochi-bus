import type { BusQuery, Direction, ResolvedBusQuery } from '../domain/bus-query'
import { classifyRouteName, type RouteCategory } from '../domain/route-category'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem } from '../domain/schedule'
import { selectBestEta } from '../domain/map/eta'
import { getSnapshotSchedule, type TransitBindings } from '../infrastructure/transit/snapshot-repository'
import { memoryCacheGet, memoryCacheSet } from './memory-cache'

export type TDXEnv = {
  TDX_CLIENT_ID: string
  TDX_CLIENT_SECRET: string
  // 使用者自備的 TDX 憑證(setup 頁的進階設定):有值時即時查詢優先用它的額度,
  // 換不到 token 就靜默退回共用憑證。只掛在請求衍生的 env 物件上,絕不落地、絕不進 log。
  TDX_USER_CLIENT_ID?: string
  TDX_USER_CLIENT_SECRET?: string
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

export class TDXServiceError extends Error {
  warning?: TDXWarning

  constructor(message: string, readonly status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TDXServiceError'
  }

  get rateLimited(): boolean {
    return this.status === 429 || this.warning === 'tdx-rate-limit' || this.warning === 'tdx-quota'
  }
}

export type TDXWarning = 'tdx-rate-limit' | 'tdx-quota' | 'tdx-unavailable'

// 給使用者看的 TDX 異常說明,唯一的一份;SSR、API 錯誤與前端輪詢共用,改文案只改這裡。
export const tdxWarningMessages: Record<TDXWarning, string> = {
  'tdx-rate-limit': 'TDX 即時查詢暫時受限（額度或頻率），地圖與已同步路網仍可使用。',
  'tdx-quota': '共用的 TDX 額度可能已用完，暫時查不到即時到站；地圖與已同步路網仍可使用，也可到「我的公車」的進階設定填自己的 TDX 憑證。',
  'tdx-unavailable': 'TDX 暫時連不上，地圖與已同步路網仍可使用。',
}

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
    body: body.slice(0, 300),
  }))
  const error = new TDXServiceError(`${context} (${response.status})`, response.status)
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
type CredentialSource = 'shared' | 'user'

// key 是 source + client_id + client_secret 的 SHA-256 指紋；Map 裡不保留原始 secret，
// 同一 client_id 換 secret、或共用/自備來源相同時也不會誤用彼此的 token。
const tokenCache = new Map<string, TokenCache>()
const pendingTokens = new Map<string, Promise<string>>()
const pendingDataRequests = new Map<string, Promise<unknown>>()

// 測試用：模擬 isolate 重建，避免模組層快取讓案例彼此污染。
export function resetTDXTestState(): void {
  sharedRateLimitedSince = null
  tokenCache.clear()
  pendingTokens.clear()
  pendingDataRequests.clear()
}

const ETA_CACHE_SECONDS = 12
const STATIC_CACHE_SECONDS = 60 * 60
const STALE_AFTER_MS = 3 * 60 * 1000
const REQUEST_TIMEOUT_MS = 6000
const MAX_TOKEN_CACHE_ENTRIES = 128
const MAX_PENDING_TOKEN_REQUESTS = 64
const MAX_PENDING_DATA_REQUESTS = 128
// 使用者憑證換到的 token 最多在伺服器記憶體留這麼久(用完即丟原則的折衷:
// 每個請求都重打 token 端點會撞它自己的頻率限制);共用憑證照 TDX 給的效期用滿。
const USER_TOKEN_MAX_SECONDS = 600
// 失效的使用者憑證短暫停用,避免每個請求都去撞 token 端點。
const INVALID_USER_KEY_SECONDS = 120

// 公路客運(公路總局)的資源掛在 /InterCity 底下,沒有 /City/{city} 路徑段;
// RouteUID 固定 THB 開頭。凡是「按路線」的即時/時刻表/站序/線形查詢都要據此換端點。
export function tdxRouteScope(city: string, routeUid?: string): string {
  return routeUid?.startsWith('THB') ? 'InterCity' : `City/${encodeURIComponent(city)}`
}

// isShared 標記這次拿到的 token 來自共用憑證還是使用者自備憑證,
// 讓呼叫端(fetchTDXJson)知道之後打 API 撞 429 時該不該算進共用額度追蹤。
export async function getTDXToken(env: TDXEnv): Promise<{ token: string; isShared: boolean }> {
  const userId = env.TDX_USER_CLIENT_ID
  const userSecret = env.TDX_USER_CLIENT_SECRET
  if (userId && userSecret) {
    const userKey = await credentialFingerprint('user', userId, userSecret)
    const invalidKey = `tdx/token-invalid/${userKey}`
    if (!memoryCacheGet<boolean>(invalidKey)) {
      try {
        return { token: await tokenFor(userId, userSecret, userKey, USER_TOKEN_MAX_SECONDS, false), isShared: false }
      } catch (error) {
        // 憑證在儲存時驗證過,執行期失效屬少見情況:記錄(絕不含憑證本身)、
        // 冷卻後退回共用憑證,讓服務不中斷。
        memoryCacheSet(invalidKey, true, INVALID_USER_KEY_SECONDS)
        console.error('tdx_user_token_failed', error instanceof Error ? error.message : String(error))
      }
    }
  }
  const sharedKey = await credentialFingerprint('shared', env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET)
  return { token: await tokenFor(env.TDX_CLIENT_ID, env.TDX_CLIENT_SECRET, sharedKey, undefined, true), isShared: true }
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

async function singleFlight<T>(
  pendingRequests: Map<string, Promise<T>>,
  key: string,
  maxEntries: number,
  request: () => Promise<T>,
): Promise<T> {
  const pending = pendingRequests.get(key)
  if (pending) return pending

  const promise = request()
  // 滿載時仍執行請求，但不再把新的 Promise 放進表內；如此能保證記憶體硬上限，
  // 也不會為了 LRU 淘汰仍在進行中的請求、反而破壞既有合併效果。
  if (pendingRequests.size >= maxEntries) return promise

  pendingRequests.set(key, promise)
  try {
    return await promise
  } finally {
    if (pendingRequests.get(key) === promise) pendingRequests.delete(key)
  }
}

async function tokenFor(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  maxSeconds: number | undefined,
  isShared: boolean,
): Promise<string> {
  const cached = cachedToken(credentialKey)
  if (cached) return cached
  return singleFlight(pendingTokens, credentialKey, MAX_PENDING_TOKEN_REQUESTS, () => (
    fetchTDXToken(clientId, clientSecret, credentialKey, maxSeconds, isShared)
  ))
}

async function fetchTDXToken(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  maxSeconds: number | undefined,
  isShared: boolean,
): Promise<string> {
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
    throw new TDXServiceError('TDX token request failed', undefined, { cause: error })
  }

  if (!response.ok) throw await tdxResponseError('TDX token request failed', response, isShared)
  if (isShared) sharedRateLimitedSince = null
  const data = await response.json() as { access_token?: string; expires_in?: number }
  if (!data.access_token) throw new TDXServiceError('TDX token response is missing access_token')

  const expiresIn = Math.max(60, Math.min(data.expires_in ?? 3600, maxSeconds ?? Number.POSITIVE_INFINITY))
  cacheToken(credentialKey, {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(30, expiresIn - 60) * 1000,
  })
  return data.access_token
}

// setup 頁「儲存並測試」用:直接打 token 端點驗證這組憑證換不換得到 token。
// 測試的憑證不論是不是共用憑證本人,都不該算進共用額度追蹤——isShared 固定 false。
export async function verifyTDXCredentials(clientId: string, clientSecret: string): Promise<void> {
  const credentialKey = await credentialFingerprint('user', clientId, clientSecret)
  await fetchTDXToken(clientId, clientSecret, credentialKey, 60, false)
}

// 把瀏覽器自帶的 TDX 憑證掛上 env(進階設定)。只對 fetch 發出的 API 請求有意義:
// 頁面導覽帶不了自訂 header,SSR 一律走共用憑證。
export function withUserTDX<E extends TDXEnv>(env: E, clientId?: string, clientSecret?: string): E {
  const id = clientId?.trim()
  const secret = clientSecret?.trim()
  if (!id || !secret || id.length > 120 || secret.length > 240) return env
  return { ...env, TDX_USER_CLIENT_ID: id, TDX_USER_CLIENT_SECRET: secret }
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
    .filter((stop) => !query.subRouteUid || !stop.subRouteUid || stop.subRouteUid === query.subRouteUid)

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
      ? await getSnapshotSchedule(env as TDXEnv & TransitBindings, query.city, query.routeName)
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
  return fetchTDXJson<ScheduleItem[]>(env, url, 6 * 60 * 60)
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
      category: classifyRouteName(item.RouteName.Zh_tw, item.RouteUID),
    }))

  return [...new Map(routes.map((route) => [route.routeName, route])).values()]
    .sort((a, b) => a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
}

// 公路客運全目錄(約 500 條、全台一份)。只取方向標籤用得到的欄位,$select 之後
// 回應只剩幾十 KB,照靜態資料的節奏快取。
async function getIntercityRouteCatalog(env: TDXEnv): Promise<RouteCatalogItem[]> {
  const url = new URL('https://tdx.transportdata.tw/api/basic/v2/Bus/Route/InterCity')
  url.searchParams.set('$select', 'RouteUID,RouteName,DepartureStopNameZh,DestinationStopNameZh')
  url.searchParams.set('$format', 'JSON')
  const data = await fetchTDXJson<RouteItem[]>(env, url, STATIC_CACHE_SECONDS)
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
    getRouteStopGroups(env, query.city, query.routeName, query.routeUid),
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
    `https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${tdxRouteScope(query.city, query.routeUid)}/${encodeURIComponent(query.routeName)}`,
  )
  url.searchParams.set('$format', 'JSON')
  return fetchTDXJson<BusETAItem[]>(env, url, ETA_CACHE_SECONDS)
}

export async function fetchTDXJson<T>(env: TDXEnv, url: URL, ttlSeconds: number): Promise<T> {
  const memoryKey = `tdx/${url.toString()}`
  const memoized = memoryCacheGet<T>(memoryKey)
  if (memoized !== undefined) return memoized

  const edgeCache = (caches as CacheStorage & { default: Cache }).default
  const cacheKey = new Request(`https://mochi-cache.invalid/tdx/${encodeURIComponent(url.toString())}`)
  const cached = await edgeCache.match(cacheKey)
  if (cached) {
    const data = await cached.json() as T
    memoryCacheSet(memoryKey, data, ttlSeconds)
    return data
  }

  const source: CredentialSource = env.TDX_USER_CLIENT_ID && env.TDX_USER_CLIENT_SECRET ? 'user' : 'shared'
  const clientId = source === 'user' ? env.TDX_USER_CLIENT_ID! : env.TDX_CLIENT_ID
  const clientSecret = source === 'user' ? env.TDX_USER_CLIENT_SECRET! : env.TDX_CLIENT_SECRET
  const credentialKey = await credentialFingerprint(source, clientId, clientSecret)
  const pendingKey = `${memoryKey}/${credentialKey}`

  return singleFlight(
    pendingDataRequests as Map<string, Promise<T>>,
    pendingKey,
    MAX_PENDING_DATA_REQUESTS,
    async () => {
      const { token, isShared } = await getTDXToken(env)
      let response: Response
      try {
        response = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
      } catch (error) {
        throw new TDXServiceError('TDX request failed', undefined, { cause: error })
      }
      if (!response.ok) throw await tdxResponseError('TDX request failed', response, isShared)
      if (isShared) sharedRateLimitedSince = null

      const data = await response.json() as T
      memoryCacheSet(memoryKey, data, ttlSeconds)
      await edgeCache.put(cacheKey, new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': `public, max-age=${ttlSeconds}`,
        },
      }))
      return data
    },
  )
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
