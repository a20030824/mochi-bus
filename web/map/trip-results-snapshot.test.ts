import { describe, expect, it } from 'vitest'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import {
  createTripResultsSnapshot,
  parseTripResultsSnapshot,
  TRIP_RESULTS_SNAPSHOT_MAX_AGE_MS,
} from './trip-results-snapshot'
import { createTripResultsState } from './trip-state'

const NOW = 1_800_000_000_000
const from = place('from', 25, 121.5)
const to = place('to', 25.1, 121.6)
const direct = directRoute('307')
const transfer = transferPlan('307', '605')

function place(placeId: string, latitude: number, longitude: number): NearbyPlace {
  return {
    placeId,
    name: placeId,
    latitude,
    longitude,
    distanceMeters: 0,
  }
}

function directRoute(routeName: string): DirectRoute {
  return {
    routeUid: `TPE${routeName}`,
    routeName,
    variantKey: `${routeName}:0`,
    direction: 0,
    label: '往終點',
    subRouteName: routeName,
    stopUid: 'stop',
    stopName: '站牌',
    stopSequence: 1,
    estimateSeconds: null,
    etaLabel: '未發車',
    stopStatus: 0,
    source: 'none',
    boardSequence: 1,
    alightSequence: 5,
    stopCount: 4,
    etaMinutes: null,
    etaSource: 'none',
    etaHeadwayMinutes: null,
  }
}

function transferPlan(first: string, second: string): TransferPlan {
  return {
    transferPlaceId: 'transfer',
    transferName: '轉乘站',
    totalStops: 8,
    first: {
      routeName: first,
      variantKey: `${first}:0`,
      label: '第一段',
      boardSequence: 1,
      alightSequence: 4,
      stopCount: 3,
    },
    second: {
      routeName: second,
      variantKey: `${second}:0`,
      label: '第二段',
      boardSequence: 2,
      alightSequence: 7,
      stopCount: 5,
    },
    firstEtaMinutes: 3,
    secondEtaMinutes: 12,
    firstEtaSource: 'realtime',
    secondEtaSource: 'schedule',
    firstEtaHeadwayMinutes: null,
    secondEtaHeadwayMinutes: [10, 15],
  }
}

function snapshot() {
  return createTripResultsSnapshot('Taipei', createTripResultsState({
    from: { place: from, coordinate: [25, 121.5] },
    to: { place: to, coordinate: [25.1, 121.6] },
    directRoutes: [direct],
    transferPlans: [],
    selectedDirectIndex: 0,
    warning: 'tdx-unavailable',
  }), NOW)
}

describe('trip results snapshot codec', () => {
  it('round-trips the version 1 history payload into a direct results state', () => {
    const encoded = snapshot()
    const decoded = parseTripResultsSnapshot(encoded, {
      city: 'Taipei',
      now: NOW + 1,
      fromPlaceId: 'from',
      toPlaceId: 'to',
    })

    expect(encoded.version).toBe(1)
    expect(decoded).toMatchObject({
      phase: 'results',
      resultKind: 'direct',
      from: { place: from, coordinate: [25, 121.5] },
      to: { place: to, coordinate: [25.1, 121.6] },
      directRoutes: [direct],
      transferPlans: [],
      selectedDirectIndex: 0,
      selectedTransferIndex: 0,
      warning: 'tdx-unavailable',
      pending: {},
    })
  })

  it('round-trips transfer-only results without inventing direct routes', () => {
    const encoded = createTripResultsSnapshot('Taipei', createTripResultsState({
      from: { place: from },
      to: { place: to },
      directRoutes: [],
      transferPlans: [transfer],
    }), NOW)
    const decoded = parseTripResultsSnapshot(encoded, { city: 'Taipei', now: NOW })

    expect(decoded).toMatchObject({
      resultKind: 'transfer',
      directRoutes: [],
      transferPlans: [transfer],
    })
  })

  it('preserves the existing direct-first rule for legacy snapshots containing both result kinds', () => {
    const decoded = parseTripResultsSnapshot({
      ...snapshot(),
      transferPlans: [transfer],
    }, { city: 'Taipei', now: NOW })

    expect(decoded).toMatchObject({
      resultKind: 'direct',
      directRoutes: [direct],
      transferPlans: [],
    })
  })

  it('rejects expired, cross-city, and mismatched endpoint snapshots', () => {
    const encoded = snapshot()

    expect(parseTripResultsSnapshot(encoded, {
      city: 'Taipei',
      now: NOW + TRIP_RESULTS_SNAPSHOT_MAX_AGE_MS,
    })).toBeUndefined()
    expect(parseTripResultsSnapshot(encoded, { city: 'NewTaipei', now: NOW })).toBeUndefined()
    expect(parseTripResultsSnapshot(encoded, {
      city: 'Taipei',
      now: NOW,
      fromPlaceId: 'other',
    })).toBeUndefined()
    expect(parseTripResultsSnapshot(encoded, {
      city: 'Taipei',
      now: NOW,
      toPlaceId: 'other',
    })).toBeUndefined()
  })

  it('rejects malformed coordinates, routes, and oversized result collections', () => {
    const encoded = snapshot()

    expect(parseTripResultsSnapshot({ ...encoded, fromCoordinate: [25, Number.NaN] }, {
      city: 'Taipei',
      now: NOW,
    })).toBeUndefined()
    expect(parseTripResultsSnapshot({
      ...encoded,
      directRoutes: [{ ...direct, etaMinutes: -1 }],
    }, { city: 'Taipei', now: NOW })).toBeUndefined()
    expect(parseTripResultsSnapshot({
      ...encoded,
      directRoutes: Array.from({ length: 31 }, () => direct),
    }, { city: 'Taipei', now: NOW })).toBeUndefined()
    expect(parseTripResultsSnapshot({
      ...encoded,
      transferPlans: Array.from({ length: 11 }, () => transfer),
    }, { city: 'Taipei', now: NOW })).toBeUndefined()
  })

  it('scrubs unknown warnings and normalizes restored result indexes', () => {
    const encoded = {
      ...snapshot(),
      warning: 'unknown-warning',
      selectedDirectIndex: 100,
      selectedTransferIndex: -5,
    }
    const decoded = parseTripResultsSnapshot(encoded, { city: 'Taipei', now: NOW })

    expect(decoded?.warning).toBeUndefined()
    expect(decoded?.selectedDirectIndex).toBe(0)
    expect(decoded?.selectedTransferIndex).toBe(0)
  })

  it('accepts snapshots without optional map coordinates', () => {
    const encoded = {
      ...snapshot(),
      fromCoordinate: undefined,
      toCoordinate: undefined,
    }
    const decoded = parseTripResultsSnapshot(encoded, { city: 'Taipei', now: NOW })

    expect(decoded?.from.coordinate).toBeUndefined()
    expect(decoded?.to.coordinate).toBeUndefined()
  })
})
