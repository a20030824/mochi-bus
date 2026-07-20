import { describe, expect, it } from 'vitest'
import {
  buildResolvedSnapshotRouteQuery,
  type SnapshotRouteSelection,
  type SnapshotRouteSelectionVariant,
} from './snapshot-route-selection'

function selection(
  routeUid = 'SNAPSHOT-ROUTE',
  subRouteUid: string | undefined = 'SNAPSHOT-SUBROUTE',
): SnapshotRouteSelection<SnapshotRouteSelectionVariant> {
  const selectedStop = {
    type: 'Feature' as const,
    properties: {
      stopUid: 'SNAPSHOT-STOP',
      stopName: '快照正式站名',
      sequence: 2,
    },
    geometry: {
      type: 'Point' as const,
      coordinates: [121, 25] as [number, number],
    },
  }
  return {
    variant: {
      routeUid,
      subRouteUid,
      direction: 0,
      stops: { features: [selectedStop] },
    },
    selectedStop,
  }
}

const baseQuery = {
  city: 'Taipei',
  routeName: '307',
  direction: 0 as const,
  stopUid: 'SNAPSHOT-STOP',
  stopName: '舊站名',
}

describe('buildResolvedSnapshotRouteQuery', () => {
  it('fills omitted route identities from the selected snapshot variant', () => {
    expect(buildResolvedSnapshotRouteQuery(baseQuery, selection())).toMatchObject({
      routeUid: 'SNAPSHOT-ROUTE',
      subRouteUid: 'SNAPSHOT-SUBROUTE',
    })
  })

  it('refreshes the physical stop identity and display name from the snapshot', () => {
    expect(buildResolvedSnapshotRouteQuery({
      ...baseQuery,
      stopName: '已改名的舊網址文字',
    }, selection())).toMatchObject({
      stopUid: 'SNAPSHOT-STOP',
      stopName: '快照正式站名',
    })
  })

  it('does not overwrite explicit route identities from the original query', () => {
    expect(buildResolvedSnapshotRouteQuery({
      ...baseQuery,
      routeUid: 'EXPLICIT-ROUTE',
      subRouteUid: 'EXPLICIT-SUBROUTE',
    }, selection('OTHER-ROUTE', 'OTHER-SUBROUTE'))).toMatchObject({
      routeUid: 'EXPLICIT-ROUTE',
      subRouteUid: 'EXPLICIT-SUBROUTE',
    })
  })

  it('keeps SubRouteUID absent when neither the query nor snapshot provides one', () => {
    expect(buildResolvedSnapshotRouteQuery(baseQuery, selection('SNAPSHOT-ROUTE', undefined))).toMatchObject({
      routeUid: 'SNAPSHOT-ROUTE',
      subRouteUid: undefined,
    })
  })
})
