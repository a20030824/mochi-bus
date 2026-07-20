import { describe, expect, it, vi } from 'vitest'
import { createNavRequestCoordinator } from '../../src/domain/map/nav-request'
import type { DirectRoute, NearbyPlace, SearchPlace, TransferPlan } from './map-api-client'
import { createTripController, type TripResultsPresentation } from './trip-controller'
import type { TripPlanLoadRequest, TripPlanLoadResult, TripPlanLoader } from './trip-plan-loader'
import { createTripRuntimeStore } from './trip-runtime-store'

function place(id: string, latitude = 25, longitude = 121, distanceMeters = 20): NearbyPlace {
  return { placeId: id, name: id, latitude, longitude, distanceMeters }
}

function searchPlace(id: string, latitude = 25, longitude = 121): SearchPlace {
  return { placeId: id, name: id, latitude, longitude }
}

function directRoute(name: string): DirectRoute {
  return {
    routeUid: `TPE-${name}`,
    routeName: name,
    variantKey: `${name}:0`,
    direction: 0,
    label: '往終點',
    subRouteName: name,
    stopUid: 'stop',
    stopName: '站牌',
    stopSequence: 1,
    estimateSeconds: null,
    etaLabel: '未發車',
    stopStatus: 0,
    source: 'none',
    boardSequence: 1,
    alightSequence: 3,
    stopCount: 2,
  }
}

function transferPlan(first = '307', second = '605'): TransferPlan {
  return {
    transferPlaceId: 'transfer',
    transferName: '轉乘站',
    totalStops: 6,
    first: {
      routeName: first,
      variantKey: `${first}:0`,
      label: '第一段',
      boardSequence: 1,
      alightSequence: 3,
      stopCount: 2,
    },
    second: {
      routeName: second,
      variantKey: `${second}:0`,
      label: '第二段',
      boardSequence: 2,
      alightSequence: 6,
      stopCount: 4,
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(options: {
  cityCode?: string
  nearby?: NearbyPlace[]
  loadNearby?: (signal?: AbortSignal) => Promise<NearbyPlace[]>
  planResult?: TripPlanLoadResult | undefined
  loadPlan?: TripPlanLoader['load']
} = {}) {
  const store = createTripRuntimeStore()
  const requests = createNavRequestCoordinator()
  let cityCode = options.cityCode ?? 'Taipei'
  const selectionSteps: string[] = []
  const candidateViews: string[] = []
  const statuses: Array<{ message: string; error: boolean }> = []
  const phases: string[] = []
  const presentations: TripResultsPresentation[] = []
  const errors: unknown[] = []
  let endpointReady = 0

  const loadNearby = vi.fn(async (
    _cityCode: string,
    _latitude: number,
    _longitude: number,
    _radius: number,
    signal?: AbortSignal,
  ) => options.loadNearby ? options.loadNearby(signal) : options.nearby ?? [])
  const loadPlan = vi.fn(options.loadPlan ?? (async (request: TripPlanLoadRequest) => {
    request.onPhase?.('direct')
    return options.planResult ?? { kind: 'empty' }
  }))
  const controller = createTripController({
    store,
    planLoader: { load: loadPlan },
    currentCityCode: () => cityCode,
    nearbyRadius: () => 500,
    loadNearby,
    beginRequest: () => requests.begin(),
    cancelRequest: () => requests.cancel(),
    isStaleRequest: (requestId) => requests.isStale(requestId),
    onSelectionStep: (kind) => selectionSteps.push(kind),
    onCandidates: (kind) => candidateViews.push(kind),
    onEndpointReady: () => { endpointReady += 1 },
    onStatus: (message, error = false) => statuses.push({ message, error }),
    onPlanStart: () => {},
    onPlanPhase: (phase) => phases.push(phase),
    onResults: async (presentation) => {
      presentations.push(presentation)
      return true
    },
    onPlanError: (error) => errors.push(error),
  })

  return {
    store,
    controller,
    loadNearby,
    loadPlan,
    selectionSteps,
    candidateViews,
    statuses,
    phases,
    presentations,
    errors,
    endpointReady: () => endpointReady,
    setCityCode(value: string) { cityCode = value },
  }
}

describe('Trip controller', () => {
  it('owns nearby candidate lookup, caps candidates, and advances to the other endpoint', async () => {
    const candidates = Array.from({ length: 7 }, (_, index) => place(`P${index}`, 25 + index / 100, 121))
    const harness = createHarness({ nearby: candidates })

    harness.controller.start()
    await harness.controller.selectCoordinate(25.1, 121.2)

    expect(harness.selectionSteps).toEqual(['from', 'to'])
    expect(harness.loadNearby).toHaveBeenCalledWith('Taipei', 25.1, 121.2, 500, expect.any(AbortSignal))
    expect(harness.store.from?.placeId).toBe('P0')
    expect(harness.store.pending('from')?.candidates).toHaveLength(5)
    expect(harness.store.pending('from')?.coordinate).toEqual([25.1, 121.2])
    expect(harness.loadPlan).not.toHaveBeenCalled()
  })

  it('selects the second endpoint, loads a direct plan, and presents the completed result', async () => {
    const routes = [directRoute('307')]
    const harness = createHarness({ planResult: { kind: 'direct', routes, warning: 'tdx-rate-limit' } })

    harness.controller.start()
    await harness.controller.selectPlace('from', searchPlace('FROM'))
    await harness.controller.selectPlace('to', searchPlace('TO', 25.2, 121.2))

    expect(harness.endpointReady()).toBe(1)
    expect(harness.phases).toEqual(['direct'])
    expect(harness.store.state).toMatchObject({
      phase: 'results',
      resultKind: 'direct',
      warning: 'tdx-rate-limit',
      directRoutes: routes,
    })
    expect(harness.presentations).toEqual([{ fitCamera: true }])
  })

  it('rejects the same physical place before starting a plan', async () => {
    const harness = createHarness()

    harness.controller.start()
    await harness.controller.selectPlace('from', searchPlace('SAME'))
    const selected = await harness.controller.selectPlace('to', searchPlace('SAME'))

    expect(selected).toBe(false)
    expect(harness.store.to).toBeUndefined()
    expect(harness.loadPlan).not.toHaveBeenCalled()
    expect(harness.statuses.at(-1)).toMatchObject({ error: true })
  })

  it('invalidates an in-flight coordinate lookup when a new Trip session starts', async () => {
    const nearby = deferred<NearbyPlace[]>()
    const harness = createHarness({ loadNearby: () => nearby.promise })

    harness.controller.start()
    const selection = harness.controller.selectCoordinate(25, 121)
    harness.controller.start()
    nearby.resolve([place('STALE')])
    await selection

    expect(harness.store.from).toBeUndefined()
    expect(harness.store.stage).toBe('from')
    expect(harness.selectionSteps).toEqual(['from', 'from'])
  })

  it('keeps coordinate selection single-flight while the nearby request is pending', async () => {
    const nearby = deferred<NearbyPlace[]>()
    const harness = createHarness({ loadNearby: () => nearby.promise })

    harness.controller.start()
    const first = harness.controller.selectCoordinate(25, 121)
    await harness.controller.selectCoordinate(25.1, 121.1)
    expect(harness.loadNearby).toHaveBeenCalledTimes(1)

    nearby.resolve([place('FROM')])
    await first
  })

  it('opens pending candidates and falls back to a focused selection step when none exist', async () => {
    const harness = createHarness()
    harness.controller.start()

    harness.controller.showCandidates('from')
    expect(harness.selectionSteps).toEqual(['from', 'from'])

    harness.store.setPending({
      kind: 'from',
      coordinate: [25, 121],
      candidates: [place('A')],
      selected: place('A'),
    })
    harness.controller.showCandidates('from')
    expect(harness.candidateViews).toEqual(['from'])
  })

  it('reselects an endpoint through the state transition and cancels stale plan completion', async () => {
    const plan = deferred<TripPlanLoadResult | undefined>()
    const harness = createHarness({ loadPlan: async (request) => {
      request.onPhase?.('direct')
      return plan.promise
    } })

    harness.controller.start()
    await harness.controller.selectPlace('from', searchPlace('FROM'))
    const selectingTo = harness.controller.selectPlace('to', searchPlace('TO'))
    harness.controller.resume('to')
    plan.resolve({ kind: 'direct', routes: [directRoute('307')] })
    await selectingTo

    expect(harness.store.state).toMatchObject({ phase: 'selecting', next: 'to' })
    expect(harness.store.to).toBeUndefined()
    expect(harness.presentations).toEqual([])
    expect(harness.errors).toEqual([])
  })

  it('completes transfer and empty results without mixing result collections', async () => {
    const plan = transferPlan()
    const transferHarness = createHarness({ planResult: { kind: 'transfer', plans: [plan] } })
    transferHarness.controller.begin(
      { place: place('FROM'), coordinate: [25, 121] },
      { place: place('TO'), coordinate: [25.2, 121.2] },
    )
    await transferHarness.controller.loadPlan()
    expect(transferHarness.store.state).toMatchObject({
      phase: 'results',
      resultKind: 'transfer',
      directRoutes: [],
      transferPlans: [plan],
    })

    const emptyHarness = createHarness({ planResult: { kind: 'empty' } })
    emptyHarness.controller.begin(
      { place: place('FROM'), coordinate: [25, 121] },
      { place: place('TO'), coordinate: [25.2, 121.2] },
    )
    await emptyHarness.controller.loadPlan()
    expect(emptyHarness.store.state).toMatchObject({
      phase: 'results',
      resultKind: 'empty',
      directRoutes: [],
      transferPlans: [],
    })
  })

  it('restores persisted results as a new session and rejects an older plan completion', async () => {
    const plan = deferred<TripPlanLoadResult | undefined>()
    const harness = createHarness({ loadPlan: () => plan.promise })
    harness.controller.begin(
      { place: place('FROM'), coordinate: [25, 121] },
      { place: place('TO'), coordinate: [25.2, 121.2] },
    )
    const loading = harness.controller.loadPlan()

    const restoredStore = createTripRuntimeStore()
    restoredStore.begin(
      { place: place('RESTORED-FROM'), coordinate: [24.9, 121] },
      { place: place('RESTORED-TO'), coordinate: [25.3, 121.3] },
    )
    restoredStore.completeDirect([directRoute('RESTORED')])
    const restored = restoredStore.results()
    if (!restored) throw new Error('expected restored Trip results')
    harness.controller.restore(restored)

    plan.resolve({ kind: 'direct', routes: [directRoute('STALE')] })
    await loading

    expect(harness.store.from?.placeId).toBe('RESTORED-FROM')
    expect(harness.store.directRoutes[0]?.routeName).toBe('RESTORED')
    expect(harness.presentations).toEqual([])
  })

  it('owns direct result selection and asks the shell to redraw the selected preview', async () => {
    const harness = createHarness()
    const routes = [directRoute('307'), directRoute('605')]
    harness.store.begin(
      { place: place('FROM'), coordinate: [25, 121] },
      { place: place('TO'), coordinate: [25.2, 121.2] },
    )
    harness.store.completeDirect(routes)

    await harness.controller.selectDirect(1)

    expect(harness.store.selectedDirectIndex).toBe(1)
    expect(harness.presentations).toEqual([{ fitCamera: true }])
  })

  it('reports active plan failures but suppresses failures after cancellation', async () => {
    const activeError = new Error('plan failed')
    const active = createHarness({ loadPlan: async () => { throw activeError } })
    active.controller.begin(
      { place: place('FROM') },
      { place: place('TO') },
    )
    await active.controller.loadPlan()
    expect(active.errors).toEqual([activeError])

    const pending = deferred<TripPlanLoadResult | undefined>()
    const cancelled = createHarness({ loadPlan: () => pending.promise })
    cancelled.controller.begin(
      { place: place('FROM') },
      { place: place('TO') },
    )
    const loading = cancelled.controller.loadPlan()
    cancelled.controller.reset()
    pending.reject(new Error('cancelled failure'))
    await loading
    expect(cancelled.errors).toEqual([])
  })
})
