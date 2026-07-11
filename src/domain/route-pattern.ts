import type { Direction } from './bus-query'

export type RoutePatternRef = {
  routeUid?: string
  subRouteUid?: string
  patternId?: string
  direction: Direction
}

export function routePatternKey(ref: RoutePatternRef, fallbackRouteName?: string): string {
  const route = ref.routeUid ? `uid:${ref.routeUid}` : `name:${fallbackRouteName ?? ''}`
  return `${route}|sub:${ref.subRouteUid ?? ''}|pattern:${ref.patternId ?? ''}|dir:${ref.direction}`
}

// 舊收藏可能沒有 subRouteUid/patternId。雙方都有值時嚴格比對；任一方缺值時
// 保留 legacy wildcard，讓舊資料能先顯示，再由 place/routes 修復成完整 identity。
export function sameRoutePattern(
  a: RoutePatternRef & { routeName?: string },
  b: RoutePatternRef & { routeName?: string },
): boolean {
  const sameRoute = a.routeUid && b.routeUid
    ? a.routeUid === b.routeUid
    : a.routeName === b.routeName
  return sameRoute
    && a.direction === b.direction
    && (!a.subRouteUid || !b.subRouteUid || a.subRouteUid === b.subRouteUid)
    && (!a.patternId || !b.patternId || a.patternId === b.patternId)
}
