import type { Direction } from './bus-query'
import { routePatternKey, sameRoutePattern } from './route-pattern'

// 常用站牌實際儲存在瀏覽器 localStorage(mochi.bus.boards.v2)。
// 舊資料可能缺 city/stopUid/stopName,讀取端必須容忍缺欄位。
export type FavoriteBus = {
  city?: string
  routeName: string
  routeUid?: string
  // 同一站牌可能有多條支線共用同一個 stopUid;有這個欄位時 ETA 才能分辨是哪一班。
  subRouteUid?: string
  // snapshot 的穩定 variant identity；TDX-only 舊資料可暫時缺少。
  patternId?: string
  identityStatus?: 'legacy-ambiguous'
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
  subRouteUid?: string
  patternId?: string
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
        subRouteUid: preset.subRouteUid,
        patternId: preset.patternId,
        identityStatus: preset.routeUid ? undefined : 'legacy-ambiguous',
        stopName: preset.stopName,
        stopUid: preset.stopUid,
        direction: preset.direction === 2 ? 2 : preset.direction === 1 ? 1 : 0,
      }],
      createdAt: preset.createdAt || now,
      updatedAt: now,
    }))
}

export function busKey(bus: Pick<FavoriteBus, 'routeUid' | 'subRouteUid' | 'patternId' | 'routeName' | 'stopUid' | 'direction'>): string {
  return `${routePatternKey(bus, bus.routeName)}|stop:${bus.stopUid ?? ''}`
}

// 封面只留一個地圖站點:保留 setup 頁手動建立的 board(無 placeId)與目前站點,其餘地圖收藏移除。
export function pruneOtherMapBoards(boards: FavoriteBoard[], city: string, placeId: string): FavoriteBoard[] {
  return boards.filter((board) => !board.placeId || (board.city === city && board.placeId === placeId))
}

// 收藏比對以穩定路線身分為準；directionLabel 只是可能變動的顯示文字。
export function sameFavoriteDirection(a: FavoriteBus, b: FavoriteBus): boolean {
  return sameRoutePattern(a, b)
    && a.stopUid === b.stopUid
}

export function normalizeFavoriteBoards(value: unknown): FavoriteBoard[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((board): board is FavoriteBoard => Boolean(
      board && typeof board === 'object' && Array.isArray((board as FavoriteBoard).buses),
    ))
    .map((board) => ({
      ...board,
      buses: board.buses.map((bus) => ({
        ...bus,
        identityStatus: bus.routeUid && (!board.placeId || bus.patternId)
          ? undefined
          : 'legacy-ambiguous' as const,
      })),
    }))
}
