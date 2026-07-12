// 常用站牌的唯一 localStorage 讀寫入口。
// 由 Vite 建成 /assets/boards.js:地圖、ETA 與 setup 頁共用同一份 store。
import {
  busKey,
  migrateLegacyPresets,
  normalizeFavoriteBoards,
  pruneOtherMapBoards,
  sameFavoriteDirection,
  type FavoriteBoard,
  type FavoriteBus,
} from '../../src/domain/favorite-board'

export { busKey, sameFavoriteDirection }
export type { FavoriteBoard, FavoriteBus }

const BOARDS_KEY = 'mochi.bus.boards.v2'
const ACTIVE_BOARD_KEY = 'mochi.bus.activeBoard.v2'
const ACTIVE_CITY_KEY = 'mochi.bus.activeCity.v1'
const LEGACY_PRESETS_KEY = 'mochi.bus.presets.v1'
const LEGACY_ACTIVE_KEY = 'mochi.bus.activePreset.v1'
const LEGACY_TDX_AUTH_KEY = 'mochi.bus.tdxAuth.v1'
const TDX_SESSION_AUTH_KEY = 'mochi.bus.tdxAuth.session.v2'
const TDX_DEVICE_AUTH_KEY = 'mochi.bus.tdxAuth.device.v2'
const TDX_MIGRATION_NOTICE_KEY = 'mochi.bus.tdxAuth.migrated.v2'

export function readBoards(): FavoriteBoard[] {
  return normalizeFavoriteBoards(readJSON(BOARDS_KEY))
}

export function writeBoards(boards: FavoriteBoard[]): void {
  localStorage.setItem(BOARDS_KEY, JSON.stringify(boards))
}

export function activeBoardId(): string | null {
  return localStorage.getItem(ACTIVE_BOARD_KEY)
}

export function setActiveBoard(id: string): void {
  localStorage.setItem(ACTIVE_BOARD_KEY, id)
}

// 確保 active 指向仍存在的 board;全刪光時移除 key。
export function syncActiveBoard(boards: FavoriteBoard[]): void {
  const active = activeBoardId()
  if (active && boards.some((board) => board.id === active)) return
  if (boards[0]) setActiveBoard(boards[0].id)
  else localStorage.removeItem(ACTIVE_BOARD_KEY)
}

export function getActiveCity(): string | null {
  return localStorage.getItem(ACTIVE_CITY_KEY)
}

export function setActiveCity(code: string): void {
  localStorage.setItem(ACTIVE_CITY_KEY, code)
}

export function newBoardId(): string {
  return crypto.randomUUID?.() || String(Date.now())
}

export function migrateBoards(): FavoriteBoard[] {
  // v2 key 存在時(包含空陣列)代表使用者動過資料,不能再次匯入舊資料。
  if (localStorage.getItem(BOARDS_KEY) !== null) return readBoards()
  const now = new Date().toISOString()
  // 只持久化真正屬於使用者的資料(舊版轉換結果,可能是空的);
  // 封面的示範站牌由頁面自己顯示,不能寫進 localStorage 假裝是使用者建的。
  const boards = migrateLegacyPresets(readJSON(LEGACY_PRESETS_KEY), now)
  writeBoards(boards)
  if (boards.length) {
    const legacyActive = localStorage.getItem(LEGACY_ACTIVE_KEY)
    setActiveBoard(legacyActive && boards.some((board) => board.id === legacyActive)
      ? legacyActive
      : boards[0].id)
  }
  return boards
}

export type FavoritePlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
}

export function isFavoriteDirection(city: string, placeId: string, bus: FavoriteBus): boolean {
  return readBoards().some((board) =>
    board.city === city
    && board.placeId === placeId
    && board.buses.some((candidate) => sameFavoriteDirection(candidate, bus)),
  )
}

export function toggleFavoriteDirection(city: string, place: FavoritePlace, bus: FavoriteBus): boolean {
  let boards = readBoards()
  let index = boards.findIndex((board) => board.city === city && board.placeId === place.placeId)
  const now = new Date().toISOString()
  let selected: boolean
  if (index >= 0 && boards[index].buses.some((candidate) => sameFavoriteDirection(candidate, bus))) {
    boards[index].buses = boards[index].buses.filter((candidate) => !sameFavoriteDirection(candidate, bus))
    boards[index].updatedAt = now
    if (!boards[index].buses.length) boards.splice(index, 1)
    selected = false
  } else if (index >= 0) {
    // 封面只留一個地圖站點:加入時同步移除其他站點的地圖收藏。
    boards = pruneOtherMapBoards(boards, city, place.placeId)
    index = boards.findIndex((board) => board.city === city && board.placeId === place.placeId)
    boards[index].buses.push(bus)
    boards[index].updatedAt = now
    selected = true
  } else {
    boards = pruneOtherMapBoards(boards, city, place.placeId)
    boards.push({
      version: 2,
      id: newBoardId(),
      title: place.name,
      city,
      placeId: place.placeId,
      latitude: place.latitude,
      longitude: place.longitude,
      buses: [bus],
      createdAt: now,
      updatedAt: now,
    })
    selected = true
  }
  writeBoards(boards)
  const placeBoard = boards.find((board) => board.city === city && board.placeId === place.placeId)
  if (placeBoard) setActiveBoard(placeBoard.id)
  else syncActiveBoard(boards)
  return selected
}

// 使用者自備的 TDX 憑證(setup 頁的進階設定)。預設只存 sessionStorage；
// 使用者明確勾選後才寫 localStorage。兩者都只在查詢時送到 Worker，不進伺服器儲存或 log。
export type TdxAuth = { clientId: string; clientSecret: string }
export type TdxAuthPersistence = 'session' | 'device'
export type TdxAuthState = { auth: TdxAuth | null; persistence: TdxAuthPersistence | null }

let memoryTdxAuth: TdxAuth | null = null
let memoryTdxPersistence: TdxAuthPersistence | null = null

export function getTdxAuth(): TdxAuth | null {
  return getTdxAuthState().auth
}

export function getTdxAuthState(): TdxAuthState {
  const session = readStoredTdxAuth(browserStorage('session'), TDX_SESSION_AUTH_KEY)
  if (session) return rememberTdxAuth(session, 'session')

  const device = readStoredTdxAuth(browserStorage('local'), TDX_DEVICE_AUTH_KEY)
  if (device) return rememberTdxAuth(device, 'device')

  if (memoryTdxAuth && memoryTdxPersistence) {
    return { auth: memoryTdxAuth, persistence: memoryTdxPersistence }
  }

  const legacyStorage = browserStorage('local')
  const legacy = readStoredTdxAuth(legacyStorage, LEGACY_TDX_AUTH_KEY)
  if (!legacy) {
    safeRemove(legacyStorage, LEGACY_TDX_AUTH_KEY)
    return { auth: null, persistence: null }
  }

  // v1 曾默認長期保存；升級時降級成當前分頁 session，並立即刪除長期副本。
  const state = rememberTdxAuth(legacy, 'session')
  safeSet(browserStorage('session'), TDX_SESSION_AUTH_KEY, JSON.stringify(legacy))
  safeSet(browserStorage('session'), TDX_MIGRATION_NOTICE_KEY, '1')
  safeRemove(legacyStorage, LEGACY_TDX_AUTH_KEY)
  return state
}

export function setTdxAuth(auth: TdxAuth, persistence: TdxAuthPersistence = 'session'): void {
  if (!isTdxAuth(auth)) throw new Error('TDX 憑證格式錯誤')
  const serialized = JSON.stringify(auth)
  const local = browserStorage('local')
  const session = browserStorage('session')

  if (persistence === 'device') {
    const hadSessionCopy = safeGet(session, TDX_SESSION_AUTH_KEY) !== null
    if (!safeSet(local, TDX_DEVICE_AUTH_KEY, serialized)) {
      throw new Error('瀏覽器無法長期保存憑證，請改用本分頁模式')
    }
    if (!safeRemove(session, TDX_SESSION_AUTH_KEY) && hadSessionCopy) {
      safeRemove(local, TDX_DEVICE_AUTH_KEY)
      throw new Error('瀏覽器無法切換憑證保存模式')
    }
  } else {
    // sessionStorage 不可用時仍保留在本頁記憶體，關頁即消失。
    const hadDeviceCopy = safeGet(local, TDX_DEVICE_AUTH_KEY) !== null
    safeSet(session, TDX_SESSION_AUTH_KEY, serialized)
    if (!safeRemove(local, TDX_DEVICE_AUTH_KEY) && hadDeviceCopy) {
      safeRemove(session, TDX_SESSION_AUTH_KEY)
      throw new Error('瀏覽器無法清除原本長期保存的憑證')
    }
  }

  safeRemove(local, LEGACY_TDX_AUTH_KEY)
  safeRemove(session, TDX_MIGRATION_NOTICE_KEY)
  rememberTdxAuth(auth, persistence)
}

export function clearTdxAuth(): void {
  memoryTdxAuth = null
  memoryTdxPersistence = null
  const local = browserStorage('local')
  const session = browserStorage('session')
  safeRemove(local, LEGACY_TDX_AUTH_KEY)
  safeRemove(local, TDX_DEVICE_AUTH_KEY)
  safeRemove(session, TDX_SESSION_AUTH_KEY)
  safeRemove(session, TDX_MIGRATION_NOTICE_KEY)
}

export function consumeTdxAuthMigrationNotice(): boolean {
  const session = browserStorage('session')
  const migrated = safeGet(session, TDX_MIGRATION_NOTICE_KEY) === '1'
  if (migrated) safeRemove(session, TDX_MIGRATION_NOTICE_KEY)
  return migrated
}

// 會落到 TDX 即時查詢的 API 呼叫帶上這組 header;沒設定憑證就是空物件,行為不變。
export function tdxHeaders(): Record<string, string> {
  const auth = getTdxAuth()
  return auth ? { 'x-tdx-client-id': auth.clientId, 'x-tdx-client-secret': auth.clientSecret } : {}
}

// 清掉這個站台的所有本機資料(常用站牌、封面指定、縣市記憶、TDX 憑證與舊版資料)。
export function clearLocalData(): void {
  for (const key of [BOARDS_KEY, ACTIVE_BOARD_KEY, ACTIVE_CITY_KEY, LEGACY_PRESETS_KEY, LEGACY_ACTIVE_KEY]) {
    localStorage.removeItem(key)
  }
  clearTdxAuth()
}

// 測試用：模擬重新載入頁面，不改動 browser storage。
export function resetTdxAuthMemoryForTests(): void {
  memoryTdxAuth = null
  memoryTdxPersistence = null
}

function rememberTdxAuth(auth: TdxAuth, persistence: TdxAuthPersistence): TdxAuthState {
  memoryTdxAuth = auth
  memoryTdxPersistence = persistence
  return { auth, persistence }
}

function isTdxAuth(value: unknown): value is TdxAuth {
  if (!value || typeof value !== 'object') return false
  const auth = value as Partial<TdxAuth>
  return typeof auth.clientId === 'string'
    && auth.clientId.length > 0
    && auth.clientId.length <= 120
    && auth.clientId.trim() === auth.clientId
    && typeof auth.clientSecret === 'string'
    && auth.clientSecret.length > 0
    && auth.clientSecret.length <= 240
    && auth.clientSecret.trim() === auth.clientSecret
}

function readStoredTdxAuth(storage: Storage | undefined, key: string): TdxAuth | null {
  const raw = safeGet(storage, key)
  if (raw === null) return null
  try {
    const value: unknown = JSON.parse(raw)
    if (isTdxAuth(value)) return value
  } catch {
    // malformed/tampered data is removed below
  }
  safeRemove(storage, key)
  return null
}

function browserStorage(kind: 'local' | 'session'): Storage | undefined {
  try {
    return kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage
  } catch {
    return undefined
  }
}

function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemove(storage: Storage | undefined, key: string): boolean {
  try {
    if (!storage) return false
    storage.removeItem(key)
    return true
  } catch {
    // Storage may be denied by browser privacy settings; memory fallback remains clearable.
    return false
  }
}

function readJSON(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}
