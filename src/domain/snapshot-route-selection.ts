import type { BusQuery, ResolvedBusQuery } from './bus-query'
import type { RouteMapVariant } from './map/map-model'

type SnapshotRouteStop = RouteMapVariant['stops']['features'][number]

export type SnapshotRouteSelectionQuery = Pick<
  BusQuery,
  'direction' | 'stopUid' | 'routeUid' | 'subRouteUid'
>

export type SnapshotRouteSelectionVariant = Pick<
  RouteMapVariant,
  'direction' | 'routeUid' | 'subRouteUid'
> & {
  stops: { features: readonly SnapshotRouteStop[] }
}

export type SnapshotRouteSelection<T extends SnapshotRouteSelectionVariant> = {
  variant: T
  selectedStop: SnapshotRouteStop
}

/**
 * Resolve a snapshot route only when the supplied physical identity identifies
 * exactly one variant. Legacy links may omit route IDs, but ambiguity must
 * remain unresolved rather than silently selecting the first branch.
 */
export function selectUniqueSnapshotRouteVariant<T extends SnapshotRouteSelectionVariant>(
  variants: readonly T[],
  query: SnapshotRouteSelectionQuery,
): SnapshotRouteSelection<T> | undefined {
  if (!query.stopUid) return undefined

  let selection: SnapshotRouteSelection<T> | undefined
  for (const variant of variants) {
    if (variant.direction !== query.direction) continue
    if (query.routeUid && variant.routeUid !== query.routeUid) continue
    if (query.subRouteUid && variant.subRouteUid !== query.subRouteUid) continue

    const selectedStop = variant.stops.features.find(
      (stop) => stop.properties.stopUid === query.stopUid,
    )
    if (!selectedStop) continue
    if (selection) return undefined
    selection = { variant, selectedStop }
  }

  return selection
}

/**
 * Complete a resolved Route query from the unique snapshot selection.
 * Explicit route identifiers remain authoritative, while the physical stop
 * identity and display name are always refreshed from the snapshot record.
 */
export function buildResolvedSnapshotRouteQuery<T extends SnapshotRouteSelectionVariant>(
  query: BusQuery,
  selection: SnapshotRouteSelection<T>,
): ResolvedBusQuery {
  return {
    ...query,
    routeUid: query.routeUid ?? selection.variant.routeUid,
    subRouteUid: query.subRouteUid ?? selection.variant.subRouteUid,
    stopUid: selection.selectedStop.properties.stopUid,
    stopName: selection.selectedStop.properties.stopName,
  }
}
