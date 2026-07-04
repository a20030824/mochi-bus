import type { Direction } from './bus-query'

// 常用站牌實際儲存在瀏覽器 localStorage(mochi.bus.boards.v2)。
// 舊資料可能缺 city/stopUid/stopName,讀取端必須容忍缺欄位。
export type FavoriteBus = {
  city?: string
  routeName: string
  routeUid?: string
  // 同一站牌可能有多條支線共用同一個 stopUid;有這個欄位時 ETA 才能分辨是哪一班。
  subRouteUid?: string
  stopName?: string
  stopUid?: string
  direction: Direction
  directionLabel?: string
}

export type FavoriteBoard = {
  version: 2
  id: string
  title: string
  // 由地圖頁建立的 board 才有 place 欄位;setup 頁建立的沒有。
  city?: string
  placeId?: string
  latitude?: number
  longitude?: number
  buses: FavoriteBus[]
  createdAt: string
  updatedAt: string
}

type LegacyPreset = {
  id?: string
  city?: string
  routeName?: string
  routeUid?: string
  stopName?: string
  stopUid?: string
  direction?: number
  label?: string
  createdAt?: string
}

export function migrateLegacyPresets(presets: unknown, now: string): FavoriteBoard[] {
  if (!Array.isArray(presets)) return []
  return (presets as Array<LegacyPreset | null | undefined>)
    .filter((preset): preset is LegacyPreset & { routeName: string; stopUid: string } =>
      Boolean(preset?.stopUid && preset?.routeName))
    .map((preset) => ({
      version: 2,
      id: preset.id ?? now,
      title: preset.stopName || preset.label || '常用站牌',
      buses: [{
        city: preset.city,
        routeName: preset.routeName,
        routeUid: preset.routeUid,
        stopName: preset.stopName,
        stopUid: preset.stopUid,
        direction: preset.direction === 1 ? 1 : 0,
      }],
      createdAt: preset.createdAt || now,
      updatedAt: now,
    }))
}

export function busKey(bus: Pick<FavoriteBus, 'routeUid' | 'routeName' | 'stopUid' | 'direction'>): string {
  return `${bus.routeUid || bus.routeName}:${bus.stopUid}:${bus.direction}`
}

// 封面只留一個地圖站點:保留 setup 頁手動建立的 board(無 placeId)與目前站點,其餘地圖收藏移除。
export function pruneOtherMapBoards(boards: FavoriteBoard[], city: string, placeId: string): FavoriteBoard[] {
  return boards.filter((board) => !board.placeId || (board.city === city && board.placeId === placeId))
}

// 同名路線可能有不同支線行駛方向,因此比對必須連 directionLabel 一起看。
export function sameFavoriteDirection(a: FavoriteBus, b: FavoriteBus): boolean {
  return a.routeUid === b.routeUid
    && a.stopUid === b.stopUid
    && a.direction === b.direction
    && (a.directionLabel ?? '') === (b.directionLabel ?? '')
}
