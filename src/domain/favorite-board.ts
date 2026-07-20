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
  // 新版地圖與 setup 都會保留穩定的站點身分；舊資料或快照缺站時可能沒有。
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

// 收藏比對以穩定路線身分為準；directionLabel 只是可能變動的顯示文字。
export function sameFavoriteDirection(a: FavoriteBus, b: FavoriteBus): boolean {
  return sameRoutePattern(a, b)
    && a.stopUid === b.stopUid
}

// 封面暫存與正式常用只比較站點身分及方向集合；時間、顯示文字與排序不影響相等性。
export function sameFavoriteBoardContent(a: FavoriteBoard, b: FavoriteBoard): boolean {
  if (!a.placeId || !b.placeId || a.city !== b.city || a.placeId !== b.placeId) return false
  if (a.buses.length !== b.buses.length) return false
  return a.buses.every((bus) => b.buses.some((candidate) => sameFavoriteDirection(candidate, bus)))
}

export function mergeFavoriteBuses(existing: FavoriteBus[], incoming: FavoriteBus[]): FavoriteBus[] {
  const merged = [...existing]
  for (const bus of incoming) {
    if (!merged.some((candidate) => sameFavoriteDirection(candidate, bus))) merged.push(bus)
  }
  return merged
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
