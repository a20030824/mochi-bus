import { describe, expect, it } from 'vitest'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import { createTripRuntimeStore } from './trip-runtime-store'
import { createTripResultsState } from './trip-state'

const from = place('from', 25, 121.5)
const to = place('to', 25.1, 121.6)
const direct = directRoute('307')
const transfer = transferPlan('307', '605')

function place(placeId: string, latitude: number, longitude: number): NearbyPlace {
  return { placeId, name: placeId, latitude, longitude, distanceMeters: 0 }
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

describe('trip runtime store', () => {
  it('uses the discriminated state as the source for stage and endpoints', () => {
    const store = createTripRuntimeStore()

    store.start()
    expect(store.stage).toBe('from')
    expect(store.selectEndpoint('from', from, [25, 121.5])).toBe(false)
    expect(store.stage).toBe('to')
    expect(store.from).toBe(from)
    expect(store.fromCoordinate).toEqual([25, 121.5])
    expect(store.selectEndpoint('to', to, [25.1, 121.6])).toBe(true)
    expect(store.stage).toBe('idle')
    expect(store.state.phase).toBe('loading')
  })

  it('keeps pending candidates in state and updates the selected match immutably', () => {
    const store = createTripRuntimeStore()
    const alternate = place('alternate', 25.02, 121.52)
    store.start()
    store.setPending({
      kind: 'from',
      coordinate: [25, 121.5],
      candidates: [from, alternate],
      selected: from,
    })

    store.updatePendingCandidate('from', alternate)
    expect(store.pending('from')?.selected).toBe(alternate)
    store.clearPending('from')
    expect(store.pending('from')).toBeUndefined()
  })

  it('carries loading warnings into mutually exclusive results', () => {
    const store = createTripRuntimeStore()
    store.begin(
      { place: from, coordinate: [25, 121.5] },
      { place: to, coordinate: [25.1, 121.6] },
    )
    store.setWarning('tdx-unavailable')
    store.completeDirect([direct])

    expect(store.state).toMatchObject({
      phase: 'results',
      resultKind: 'direct',
      warning: 'tdx-unavailable',
      directRoutes: [direct],
      transferPlans: [],
    })
    store.completeTransfer([transfer])
    expect(store.state).toMatchObject({
      phase: 'results',
      resultKind: 'transfer',
      directRoutes: [],
      transferPlans: [transfer],
    })
  })

  it('normalizes selected indexes through state transitions', () => {
    const store = createTripRuntimeStore(createTripResultsState({
      from: { place: from },
      to: { place: to },
      directRoutes: [direct, directRoute('605')],
      transferPlans: [],
    }))

    store.selectDirect(99)
    expect(store.selectedDirectIndex).toBe(1)
    store.selectTransfer(99)
    expect(store.selectedTransferIndex).toBe(0)
  })

  it('restores, focuses, and resets without parallel runtime fields', () => {
    const restored = createTripResultsState({
      from: { place: from },
      to: { place: to },
      directRoutes: [],
      transferPlans: [transfer],
    })
    const store = createTripRuntimeStore()

    store.restore(restored)
    expect(store.hasResults()).toBe(true)
    expect(store.results()).toBe(restored)
    store.focus('to')
    expect(store.state).toMatchObject({ phase: 'selecting', next: 'to' })
    expect(store.from).toBe(from)
    expect(store.to).toBe(to)
    store.reset()
    expect(store.state).toEqual({ phase: 'idle' })
    expect(store.hasResults()).toBe(false)
  })
})
