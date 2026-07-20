import { describe, expect, it } from 'vitest'
import type { StopGroup } from '../lib/tdx'
import {
  selectRouteStopGroup,
  type RouteStopGroupSelectionQuery,
} from './route-stop-group-selection'

const query: RouteStopGroupSelectionQuery = {
  direction: 0,
  stopUid: 'STOP-2',
  routeUid: 'ROUTE-A',
  subRouteUid: 'SUB-A',
}

function stopGroup(
  routeUid: string,
  subRouteUid: string,
  direction: 0 | 1 | 2 = 0,
  stopUid = 'STOP-2',
): StopGroup {
  return {
    direction,
    label: routeUid + ' direction',
    routeUid,
    subRouteUid,
    subRouteName: subRouteUid,
    stops: [{
      routeUid,
      subRouteUid,
      subRouteName: subRouteUid,
      stopUid,
      stopName: stopUid,
      direction,
      sequence: 1,
    }],
  }
}

describe('selectRouteStopGroup', () => {
  it('selects the exact route and sub-route identity', () => {
    const other = stopGroup('ROUTE-A', 'SUB-B')
    const exact = stopGroup('ROUTE-A', 'SUB-A')

    expect(selectRouteStopGroup([other, exact], query)).toBe(exact)
  })

  it('fails closed when an explicit sub-route identity does not match', () => {
    expect(selectRouteStopGroup([
      stopGroup('ROUTE-A', 'SUB-B'),
      stopGroup('ROUTE-B', 'SUB-A'),
    ], query)).toBeUndefined()
  })

  it('prefers an exact route identity before the legacy fallback', () => {
    const fallback = stopGroup('ROUTE-B', 'SUB-B')
    const exact = stopGroup('ROUTE-A', 'SUB-A')

    expect(selectRouteStopGroup([fallback, exact], { ...query, subRouteUid: undefined })).toBe(exact)
  })

  it('preserves the legacy direction-and-stop fallback without a sub-route identity', () => {
    const fallback = stopGroup('ROUTE-B', 'SUB-B')

    expect(selectRouteStopGroup([fallback], {
      ...query,
      routeUid: 'STALE-ROUTE',
      subRouteUid: undefined,
    })).toBe(fallback)
  })

  it('does not cross direction or physical stop identity', () => {
    expect(selectRouteStopGroup([
      stopGroup('ROUTE-A', 'SUB-A', 1),
      stopGroup('ROUTE-A', 'SUB-A', 0, 'OTHER-STOP'),
    ], { ...query, subRouteUid: undefined })).toBeUndefined()
  })
})
