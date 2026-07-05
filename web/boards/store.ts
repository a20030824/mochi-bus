// 常用站牌的唯一 localStorage 讀寫入口。
// 由 Vite 建成 /assets/boards.js:地圖頁(web/map)直接 import,
// ETA 與 setup 頁的 inline module script 也從同一個 URL import,避免三處各寫一份。
import {
  busKey,
  migrateLegacyPresets,
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

export function readBoards(): FavoriteBoard[] {
  const value = readJSON(BOARDS_KEY)
  return Array.isArray(value) ? value as FavoriteBoard[] : []
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

// 清掉這個站台的所有本機資料(常用站牌、封面指定、縣市記憶與舊版資料)。
export function clearLocalData(): void {
  for (const key of [BOARDS_KEY, ACTIVE_BOARD_KEY, ACTIVE_CITY_KEY, LEGACY_PRESETS_KEY, LEGACY_ACTIVE_KEY]) {
    localStorage.removeItem(key)
  }
}

function readJSON(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null
  }
}
