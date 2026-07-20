import { describe, expect, it } from 'vitest'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import {
  clearTripPendingSelection,
  completeTripResults,
  createTripResultsState,
  hasTripResultsState,
  idleTripState,
  normalizeTripResultIndex,
  resumeTripEndpoint,
  selectDirectTripResult,
  selectTransferTripResult,
  selectTripEndpoint,
  setTripPendingSelection,
  startTripSelection,
  tripEndpoint,
  tripPendingSelection,
} from './trip-state'

const from = endpoint('from', 25, 121.5)
const to = endpoint('to', 25.1, 121.6)
const directRoutes = [directRoute('307'), directRoute('605')]
const transferPlans = [transferPlan('307', '605')]

function endpoint(placeId: string, latitude: number, longitude: number) {
  return {
    place: place(placeId, latitude, longitude),
    coordinate: [latitude, longitude] as [number, number],
  }
}

function place(placeId: string, latitude = 25, longitude = 121.5): NearbyPlace {
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
  }
}

describe('trip state transitions', () => {
  it('moves from idle through endpoint selection into loading', () => {
    const started = startTripSelection()
    const selectedFrom = selectTripEndpoint(started, 'from', from)
    const selectedTo = selectTripEndpoint(selectedFrom, 'to', to)

    expect(started).toEqual({ phase: 'selecting', next: 'from', pending: {} })
    expect(selectedFrom).toMatchObject({ phase: 'selecting', next: 'to', from })
    expect(selectedTo).toEqual({ phase: 'loading', from, to, pending: {} })
  })

  it('preserves the opposite endpoint while reselecting one side', () => {
    const results = createTripResultsState({
      from,
      to,
      directRoutes,
      transferPlans: [],
    })

    expect(resumeTripEndpoint(results, 'to')).toEqual({
      phase: 'selecting',
      next: 'to',
      from,
      to: undefined,
      pending: {},
    })
    expect(resumeTripEndpoint(results, 'from')).toEqual({
      phase: 'selecting',
      next: 'from',
      from: undefined,
      to,
      pending: {},
    })
  })

  it('keeps candidate matching state across selecting, loading, and results', () => {
    const candidate = place('candidate')
    const pending = {
      kind: 'from' as const,
      coordinate: [25.02, 121.52] as [number, number],
      candidates: [candidate],
      selected: candidate,
    }
    const selecting = setTripPendingSelection(startTripSelection(), pending)
    const withFrom = selectTripEndpoint(selecting, 'from', from)
    const loading = selectTripEndpoint(withFrom, 'to', to)
    if (loading.phase !== 'loading') throw new Error('expected both endpoints to enter loading')
    const results = completeTripResults(loading, {
      directRoutes,
      transferPlans: [],
      selectedDirectIndex: 0,
      selectedTransferIndex: 0,
      warning: undefined,
    })

    expect(tripPendingSelection(selecting, 'from')).toBe(pending)
    expect(tripPendingSelection(loading, 'from')).toBe(pending)
    expect(tripPendingSelection(results, 'from')).toBe(pending)
    expect(tripEndpoint(results, 'to')).toBe(to)
    expect(clearTripPendingSelection(results, 'from').phase).toBe('results')
    expect(tripPendingSelection(clearTripPendingSelection(results, 'from'), 'from')).toBeUndefined()
  })

  it('makes direct, transfer, and empty result collections mutually exclusive', () => {
    const directResults = createTripResultsState({
      from,
      to,
      directRoutes,
      transferPlans,
      selectedDirectIndex: 99,
      selectedTransferIndex: 5,
    })
    const transferResults = createTripResultsState({
      from,
      to,
      directRoutes: [],
      transferPlans,
      selectedTransferIndex: 8,
    })
    const emptyResults = createTripResultsState({
      from,
      to,
      directRoutes: [],
      transferPlans: [],
    })

    expect(directResults).toMatchObject({
      resultKind: 'direct',
      selectedDirectIndex: 1,
      selectedTransferIndex: 0,
      transferPlans: [],
    })
    expect(transferResults).toMatchObject({
      resultKind: 'transfer',
      selectedDirectIndex: 0,
      selectedTransferIndex: 0,
      directRoutes: [],
    })
    expect(emptyResults).toMatchObject({
      resultKind: 'empty',
      selectedDirectIndex: 0,
      selectedTransferIndex: 0,
      directRoutes: [],
      transferPlans: [],
    })
    expect(selectDirectTripResult(directResults, -5).selectedDirectIndex).toBe(0)
    expect(selectTransferTripResult(transferResults, 9).selectedTransferIndex).toBe(0)
    expect(hasTripResultsState(directResults)).toBe(true)
    expect(hasTripResultsState(transferResults)).toBe(true)
    expect(hasTripResultsState(emptyResults)).toBe(false)
    expect(hasTripResultsState(idleTripState())).toBe(false)
  })

  it('normalizes invalid indexes without leaking NaN or out-of-range values', () => {
    expect(normalizeTripResultIndex(undefined, 2)).toBe(0)
    expect(normalizeTripResultIndex(Number.NaN, 2)).toBe(0)
    expect(normalizeTripResultIndex(1, 2)).toBe(1)
    expect(normalizeTripResultIndex(2, 2)).toBe(1)
    expect(normalizeTripResultIndex(1, 0)).toBe(0)
  })
})
