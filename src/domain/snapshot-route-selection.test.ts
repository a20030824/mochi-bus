import { describe, expect, it } from 'vitest'
import {
  selectUniqueSnapshotRouteVariant,
  type SnapshotRouteSelectionVariant,
} from './snapshot-route-selection'

function stop(stopUid: string, stopName = stopUid) {
  return {
    type: 'Feature' as const,
    properties: { stopUid, stopName, sequence: 1 },
    geometry: {
      type: 'Point' as const,
      coordinates: [121, 25] as [number, number],
    },
  }
}

function variant(
  routeUid: string,
  subRouteUid: string | undefined,
  direction: 0 | 1 | 2,
  stopUids: string[],
): SnapshotRouteSelectionVariant {
  return {
    routeUid,
    subRouteUid,
    direction,
    stops: { features: stopUids.map((stopUid) => stop(stopUid)) },
  }
}

const baseQuery = {
  direction: 0 as const,
  stopUid: 'STOP-2',
  routeUid: 'ROUTE-A',
  subRouteUid: 'SUB-A',
}

describe('selectUniqueSnapshotRouteVariant', () => {
  it('returns the matching variant together with the physical selected stop', () => {
    const target = variant('ROUTE-A', 'SUB-A', 0, ['STOP-1', 'STOP-2'])

    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 1, ['STOP-2']),
      target,
    ], baseQuery)).toEqual({
      variant: target,
      selectedStop: target.stops.features[1],
    })
  })

  it('recovers a legacy link without route IDs when the physical identity is unique', () => {
    const target = variant('ROUTE-A', 'SUB-A', 0, ['STOP-2'])

    expect(selectUniqueSnapshotRouteVariant([
      target,
      variant('ROUTE-B', 'SUB-B', 0, ['OTHER']),
    ], {
      direction: 0,
      stopUid: 'STOP-2',
    })?.variant).toBe(target)
  })

  it('rejects a legacy link when multiple branches contain the same physical stop', () => {
    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 0, ['STOP-2']),
      variant('ROUTE-A', 'SUB-B', 0, ['STOP-2']),
    ], {
      direction: 0,
      stopUid: 'STOP-2',
    })).toBeUndefined()
  })

  it('uses a supplied RouteUID to narrow otherwise ambiguous route variants', () => {
    const target = variant('ROUTE-B', 'SUB-B', 0, ['STOP-2'])

    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 0, ['STOP-2']),
      target,
    ], {
      direction: 0,
      stopUid: 'STOP-2',
      routeUid: 'ROUTE-B',
    })?.variant).toBe(target)
  })

  it('uses a supplied SubRouteUID to select one branch of the same route', () => {
    const target = variant('ROUTE-A', 'SUB-B', 0, ['STOP-2'])

    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 0, ['STOP-2']),
      target,
    ], {
      direction: 0,
      stopUid: 'STOP-2',
      routeUid: 'ROUTE-A',
      subRouteUid: 'SUB-B',
    })?.variant).toBe(target)
  })

  it('does not ignore an explicit but mismatched route identity', () => {
    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 0, ['STOP-2']),
    ], {
      ...baseQuery,
      routeUid: 'WRONG',
    })).toBeUndefined()

    expect(selectUniqueSnapshotRouteVariant([
      variant('ROUTE-A', 'SUB-A', 0, ['STOP-2']),
    ], {
      ...baseQuery,
      subRouteUid: 'WRONG',
    })).toBeUndefined()
  })

  it('rejects a missing StopUID, wrong direction, or absent physical stop', () => {
    const variants = [variant('ROUTE-A', 'SUB-A', 0, ['STOP-1'])]

    expect(selectUniqueSnapshotRouteVariant(variants, {
      direction: 0,
      routeUid: 'ROUTE-A',
      subRouteUid: 'SUB-A',
    })).toBeUndefined()
    expect(selectUniqueSnapshotRouteVariant(variants, {
      ...baseQuery,
      direction: 1,
    })).toBeUndefined()
    expect(selectUniqueSnapshotRouteVariant(variants, baseQuery)).toBeUndefined()
  })
})
