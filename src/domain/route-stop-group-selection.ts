import type { ResolvedBusQuery } from './bus-query'
import type { StopGroup } from '../lib/tdx'

export type RouteStopGroupSelectionQuery = Pick<
  ResolvedBusQuery,
  'direction' | 'stopUid' | 'routeUid' | 'subRouteUid'
>

/**
 * Select the station-order variant used by both Route SSR and realtime ETA.
 *
 * The secondary lookup intentionally preserves the existing legacy-link rule:
 * when no SubRouteUID is available, direction plus physical StopUID may recover
 * the route pattern even if the optional RouteUID does not identify a group.
 */
export function selectRouteStopGroup(
  groups: readonly StopGroup[],
  query: RouteStopGroupSelectionQuery,
): StopGroup | undefined {
  const exact = groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid),
  )
  if (exact || query.subRouteUid) return exact

  return groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  )
}
