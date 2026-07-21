// 常用站牌與首頁暫存的唯一 localStorage 讀寫入口。
// 由 Vite 建成 /assets/boards.js:地圖、ETA 與 setup 頁共用同一份 store。
import {
  APPEARANCE_STORAGE_KEY,
  LEGACY_APPEARANCE_STORAGE_KEYS,
  LOCAL_DATA_CLEARED_EVENT,
} from '../../src/domain/appearance'
import {
  busKey,
  mergeFavoriteBuses,
  migrateLegacyPresets,
  normalizeFavoriteBoards,
  sameFavoriteBoardContent,
  sameFavoriteDirection,
  type FavoriteBoard,
  type FavoriteBus,
} from '../../src/domain/favorite-board'

export { busKey, sameFavoriteBoardContent, sameFavoriteDirection }
export type { FavoriteBoard, FavoriteBus }

const BOARDS_KEY = 'mochi.bus.boards.v2'
const HOME_BOARD_KEY = 'mochi.bus.homeBoard.v1'
const ACTIVE_BOARD_KEY = 'mochi.bus.activeBoard.v2'
const ACTIVE_CITY_KEY = 'mochi.bus.activeCity.v1'
const LEGACY_PRESETS_KEY = 'mochi.bus.presets.v1'
const LEGACY_ACTIVE_KEY = 'mochi.bus.activePreset.v1'
const LEGACY_TDX_AUTH_KEY = 'mochi.bus.tdxAuth.v1'
const TDX_SESSION_AUTH_KEY = 'mochi.bus.tdxAuth.session.v2'
const TDX_DEVICE_AUTH_KEY = 'mochi.bus.tdxAuth.device.v2'
const TDX_MIGRATION_NOTICE_KEY = 'mochi.bus.tdxAuth.migrated.v2'

export const HOME_DIRECTION_CHANGED_EVENT = 'mochi:home-direction-changed'

export type HomeDirectionChangedDetail = {
  placeName: string
  selected: boolean
  homeTitle?: string
}

export function readBoards(): FavoriteBoard[] {
  return normalizeFavoriteBoards(readJSON(BOARDS_KEY))
}

export function writeBoards(boards: FavoriteBoard[]): void {
  localStorage.setItem(BOARDS_KEY, JSON.stringify(boards))
}

export function readHomeBoard(): FavoriteBoard | null {
  return normalizeFavoriteBoards([readJSON(HOME_BOARD_KEY)])[0] ?? null
}

export function writeHomeBoard(board: FavoriteBoard): void {
  localStorage.setItem(HOME_BOARD_KEY, JSON.stringify(board))
}

export function clearHomeBoard(): void {
  localStorage.removeItem(HOME_BOARD_KEY)
}

export function activeBoardId(): string | null {
  return localStorage.getItem(ACTIVE_BOARD_KEY)
}

function writeActiveBoard(id: string): void {
  localStorage.setItem(ACTIVE_BOARD_KEY, id)
}

// 明確選擇一塊正式常用時，離開地圖暫存封面。
export function setActiveBoard(id: string): void {
  clearHomeBoard()
  writeActiveBoard(id)
}

// 確保 active 指向仍存在的 board;全刪光時移除 key。這是資料修復，不應清掉暫存封面。
export function syncActiveBoard(boards: FavoriteBoard[]): void {
  const active = activeBoardId()
  if (active && boards.some((board) => board.id === active)) return
  if (boards[0]) writeActiveBoard(boards[0].id)
  else localStorage.removeItem(ACTIVE_BOARD_KEY)
}

export function resolveHomeBoard(boards: FavoriteBoard[] = readBoards()): FavoriteBoard | null {
  const draft = readHomeBoard()
  if (draft) return boards.find((board) => sameFavoriteBoardContent(board, draft)) ?? draft
  const active = activeBoardId()
  return (active ? boards.find((board) => board.id === active) : undefined) ?? boards[0] ?? null
}

function reconcileHomeBoard(boards: FavoriteBoard[]): void {
  const draft = readHomeBoard()
  if (!draft) return
  const exact = boards.find((board) => sameFavoriteBoardContent(board, draft))
  if (!exact) return
  clearHomeBoard()
  writeActiveBoard(exact.id)
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
  if (localStorage.getItem(BOARDS_KEY) !== null) {
    const boards = readBoards()
    reconcileHomeBoard(boards)
    return boards
  }
  const now = new Date().toISOString()
  // 只持久化真正屬於使用者的資料(舊版轉換結果,可能是空的);
  // 封面的示範站牌由頁面自己顯示,不能寫進 localStorage 假裝是使用者建的。
  const boards = migrateLegacyPresets(readJSON(LEGACY_PRESETS_KEY), now)
  writeBoards(boards)
  if (boards.length) {
    const legacyActive = localStorage.getItem(LEGACY_ACTIVE_KEY)
    writeActiveBoard(legacyActive && boards.some((board) => board.id === legacyActive)
      ? legacyActive
      : boards[0].id)
  }
  reconcileHomeBoard(boards)
  return boards
}

export type FavoritePlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
}

export function isHomeDirection(city: string, placeId: string, bus: FavoriteBus): boolean {
  const home = resolveHomeBoard(readBoards())
  return Boolean(home
    && home.city === city
    && home.placeId === placeId
    && home.buses.some((candidate) => sameFavoriteDirection(candidate, bus)))
}

export function toggleHomeDirection(city: string, place: FavoritePlace, bus: FavoriteBus): boolean {
  const boards = readBoards()
  const current = resolveHomeBoard(boards)
  const storedDraft = readHomeBoard()
  const samePlace = current?.city === city && current.placeId === place.placeId
  const now = new Date().toISOString()
  const draft: FavoriteBoard = samePlace && current
    ? {
        ...current,
        id: storedDraft?.id === current.id ? current.id : newBoardId(),
        title: place.name,
        latitude: place.latitude,
        longitude: place.longitude,
        buses: [...current.buses],
        updatedAt: now,
      }
    : {
        version: 2,
        id: newBoardId(),
        title: place.name,
        city,
        placeId: place.placeId,
        latitude: place.latitude,
        longitude: place.longitude,
        buses: [],
        createdAt: now,
        updatedAt: now,
      }

  const wasSelected = draft.buses.some((candidate) => sameFavoriteDirection(candidate, bus))
  draft.buses = wasSelected
    ? draft.buses.filter((candidate) => !sameFavoriteDirection(candidate, bus))
    : [...draft.buses, bus]

  if (!draft.buses.length) {
    clearHomeBoard()
    const currentSaved = current ? boards.find((board) => sameFavoriteBoardContent(board, current)) : undefined
    const fallback = boards.find((board) => board.id !== currentSaved?.id) ?? currentSaved
    if (fallback) writeActiveBoard(fallback.id)
    else localStorage.removeItem(ACTIVE_BOARD_KEY)
    const selected = Boolean(fallback
      && fallback.city === city
      && fallback.placeId === place.placeId
      && fallback.buses.some((candidate) => sameFavoriteDirection(candidate, bus)))
    announceHomeDirection({ placeName: place.name, selected, homeTitle: fallback?.title })
    return selected
  }

  const exact = boards.find((board) => sameFavoriteBoardContent(board, draft))
  if (exact) {
    clearHomeBoard()
    writeActiveBoard(exact.id)
  } else {
    writeHomeBoard(draft)
  }

  const home = exact ?? draft
  const selected = home.buses.some((candidate) => sameFavoriteDirection(candidate, bus))
  announceHomeDirection({ placeName: place.name, selected, homeTitle: home.title })
  return selected
}

export function saveHomeBoardToFavorites(): FavoriteBoard | null {
  const home = readHomeBoard()
  if (!home) return null
  const boards = readBoards()
  const exact = boards.find((board) => sameFavoriteBoardContent(board, home))
  if (exact) {
    clearHomeBoard()
    writeActiveBoard(exact.id)
    return exact
  }

  const samePlaceIndex = boards.findIndex((board) => board.city === home.city && board.placeId === home.placeId)
  const now = new Date().toISOString()
  let saved: FavoriteBoard
  if (samePlaceIndex >= 0) {
    saved = {
      ...boards[samePlaceIndex],
      latitude: home.latitude ?? boards[samePlaceIndex].latitude,
      longitude: home.longitude ?? boards[samePlaceIndex].longitude,
      buses: mergeFavoriteBuses(boards[samePlaceIndex].buses, home.buses),
      updatedAt: now,
    }
    boards[samePlaceIndex] = saved
  } else {
    saved = {
      ...home,
      id: newBoardId(),
      createdAt: now,
      updatedAt: now,
    }
    boards.push(saved)
  }
  writeBoards(boards)
  clearHomeBoard()
  writeActiveBoard(saved.id)
  return saved
}

export function persistHomeBoard(board: FavoriteBoard): void {
  const draft = readHomeBoard()
  if (draft?.id === board.id) {
    writeHomeBoard(board)
    return
  }
  writeBoards(readBoards().map((candidate) => candidate.id === board.id ? board : candidate))
}

function announceHomeDirection(detail: HomeDirectionChangedDetail): void {
  if (typeof globalThis.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return
  queueMicrotask(() => globalThis.dispatchEvent(new CustomEvent(HOME_DIRECTION_CHANGED_EVENT, { detail })))
}

// 使用者自備的 TDX 憑證(setup 頁的進階設定)。預設只存 sessionStorage；
// 使用者明確勾選後才寫 localStorage。Client Secret 只在瀏覽器與 TDX token endpoint
// 之間傳送；查詢時 Worker 只接收短效 access token，兩者都不由 Worker 保存或寫入 log。
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
// 清掉這個站台的所有本機資料(常用站牌、首頁暫存、封面指定、縣市記憶、外觀、TDX 憑證與舊版資料)。
export function clearLocalData(): void {
  for (const key of [
    BOARDS_KEY,
    HOME_BOARD_KEY,
    ACTIVE_BOARD_KEY,
    ACTIVE_CITY_KEY,
    LEGACY_PRESETS_KEY,
    LEGACY_ACTIVE_KEY,
    APPEARANCE_STORAGE_KEY,
    ...LEGACY_APPEARANCE_STORAGE_KEYS,
  ]) {
    localStorage.removeItem(key)
  }
  clearTdxAuth()
  if (typeof globalThis.dispatchEvent === 'function' && typeof Event === 'function') {
    globalThis.dispatchEvent(new Event(LOCAL_DATA_CLEARED_EVENT))
  }
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
