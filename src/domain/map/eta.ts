import type { BusETAItem } from '../../lib/tdx'

export type StopRouteRef = {
  routeUid: string
  stopUid: string
  direction: number
}

export function matchingEtaItems(items: BusETAItem[], route: StopRouteRef): BusETAItem[] {
  return items.filter((item) =>
    item.StopUID === route.stopUid
    && item.Direction === route.direction
    && (!item.RouteUID || item.RouteUID === route.routeUid),
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
