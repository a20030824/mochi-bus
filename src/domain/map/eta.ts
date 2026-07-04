import type { BusETAItem } from '../../lib/tdx'

export type StopRouteRef = {
  routeUid?: string
  stopUid: string
  direction: number
  subRouteUid?: string
}

export function matchingEtaItems(items: BusETAItem[], route: StopRouteRef): BusETAItem[] {
  return items.filter((item) =>
    item.StopUID === route.stopUid
    && item.Direction === route.direction
    && (!route.routeUid || !item.RouteUID || item.RouteUID === route.routeUid)
    // 同一 routeUid 底下的支線可能共用同一個 stopUid+direction(例如共站的幹線與支線變體)。
    // 兩邊都有 subRouteUid 時才要求相符,任一邊缺值就當作無法分辨、不排除。
    && (!route.subRouteUid || !item.SubRouteUID || item.SubRouteUID === route.subRouteUid),
  )
}

export function selectBestEta(items: BusETAItem[], route: StopRouteRef): BusETAItem | undefined {
  return matchingEtaItems(items, route).sort((a, b) => {
    const aEstimate = typeof a.EstimateTime === 'number' ? Math.max(0, a.EstimateTime) : Number.POSITIVE_INFINITY
    const bEstimate = typeof b.EstimateTime === 'number' ? Math.max(0, b.EstimateTime) : Number.POSITIVE_INFINITY
    if (aEstimate !== bEstimate) return aEstimate - bEstimate
    return etaStatusRank(a.StopStatus) - etaStatusRank(b.StopStatus)
  })[0]
}

function etaStatusRank(status?: number): number {
  if (status === 0) return 0
  if (status === 1) return 1
  if (status === 2 || status === 3) return 2
  if (status === 4) return 3
  return 4
}
