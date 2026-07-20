import { describe, expect, it, vi } from 'vitest'
import type { NearbyPlace } from './map-api-client'
import {
  createNearbyPlacesController,
  type NearbyPlacesFailure,
  type NearbyPlacesPresentation,
  type NearbyPlacesRequest,
} from './nearby-places-controller'

function place(index: number): NearbyPlace {
  return {
    placeId: `P${index}`,
    name: `Place ${index}`,
    latitude: 25 + index / 1000,
    longitude: 121 + index / 1000,
    distanceMeters: index * 10,
  }
}

function request(overrides: Partial<NearbyPlacesRequest> = {}): NearbyPlacesRequest {
  return {
    cityCode: 'Taipei',
    origin: [25, 121],
    radiusMeters: 500,
    autoPreview: false,
    ...overrides,
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
  loadNearby?: (
    cityCode: string,
    latitude: number,
    longitude: number,
    radiusMeters: number,
    signal?: AbortSignal,
  ) => Promise<NearbyPlace[]>
  placeLimit?: number
} = {}) {
  let cityCode: string | undefined = 'Taipei'
  let latestRequestId = 0
  const starts: NearbyPlacesRequest[] = []
  const presentations: NearbyPlacesPresentation[] = []
  const previews: Array<{ place: NearbyPlace; presentation: NearbyPlacesPresentation }> = []
  const failures: NearbyPlacesFailure[] = []
  const loadNearby = vi.fn(options.loadNearby ?? (async () => [place(1), place(2)]))
  const controller = createNearbyPlacesController({
    currentCityCode: () => cityCode,
    beginRequest: () => {
      latestRequestId += 1
      return { requestId: latestRequestId, signal: new AbortController().signal }
    },
    isStaleRequest: (requestId) => requestId !== latestRequestId,
    loadNearby,
    onStart: (value) => starts.push(value),
    onPlaces: (value) => presentations.push(value),
    onAutoPreview: (value, presentation) => { previews.push({ place: value, presentation }) },
    onError: (value) => failures.push(value),
    placeLimit: options.placeLimit,
  })

  return {
    controller,
    loadNearby,
    starts,
    presentations,
    previews,
    failures,
    setCityCode(value: string | undefined) { cityCode = value },
    invalidateRequest() { latestRequestId += 1 },
  }
}

describe('Nearby places controller', () => {
  it('loads a bounded list and auto-previews the first place after presentation', async () => {
    const places = Array.from({ length: 15 }, (_, index) => place(index))
    const harness = createHarness({ loadNearby: async () => places })
    const loadRequest = request({ autoPreview: true })

    await expect(harness.controller.load(loadRequest)).resolves.toBe(true)

    expect(harness.starts).toEqual([loadRequest])
    expect(harness.loadNearby).toHaveBeenCalledWith('Taipei', 25, 121, 500, expect.any(AbortSignal))
    expect(harness.presentations).toHaveLength(1)
    expect(harness.presentations[0].places).toEqual(places.slice(0, 12))
    expect(harness.previews).toEqual([{
      place: places[0],
      presentation: harness.presentations[0],
    }])
    expect(harness.failures).toEqual([])
  })

  it('does not auto-preview an empty result or a request that disabled it', async () => {
    const empty = createHarness({ loadNearby: async () => [] })
    await expect(empty.controller.load(request({ autoPreview: true }))).resolves.toBe(true)
    expect(empty.previews).toEqual([])

    const disabled = createHarness()
    await expect(disabled.controller.load(request())).resolves.toBe(true)
    expect(disabled.previews).toEqual([])
  })

  it('suppresses an older completion after a newer request starts', async () => {
    const first = deferred<NearbyPlace[]>()
    const harness = createHarness({
      loadNearby: async (_city, latitude) => latitude === 24 ? first.promise : [place(2)],
    })

    const oldLoad = harness.controller.load(request({ origin: [24, 120] }))
    const newLoad = harness.controller.load(request({ origin: [25, 121] }))
    await expect(newLoad).resolves.toBe(true)
    first.resolve([place(1)])
    await expect(oldLoad).resolves.toBe(false)

    expect(harness.presentations).toHaveLength(1)
    expect(harness.presentations[0].origin).toEqual([25, 121])
  })

  it('suppresses results and failures after city changes, cancellation, or request invalidation', async () => {
    const cityPending = deferred<NearbyPlace[]>()
    const cityChanged = createHarness({ loadNearby: () => cityPending.promise })
    const cityLoad = cityChanged.controller.load(request())
    cityChanged.setCityCode('NewTaipei')
    cityPending.resolve([place(1)])
    await expect(cityLoad).resolves.toBe(false)
    expect(cityChanged.presentations).toEqual([])

    const cancelledPending = deferred<NearbyPlace[]>()
    const cancelled = createHarness({ loadNearby: () => cancelledPending.promise })
    const cancelledLoad = cancelled.controller.load(request())
    cancelled.controller.cancel()
    cancelledPending.reject(new Error('cancelled'))
    await expect(cancelledLoad).resolves.toBe(false)
    expect(cancelled.failures).toEqual([])

    const stalePending = deferred<NearbyPlace[]>()
    const stale = createHarness({ loadNearby: () => stalePending.promise })
    const staleLoad = stale.controller.load(request())
    stale.invalidateRequest()
    stalePending.resolve([place(1)])
    await expect(staleLoad).resolves.toBe(false)
    expect(stale.presentations).toEqual([])
  })

  it('reports active errors and retries the latest request', async () => {
    const error = new Error('nearby failed')
    let attempt = 0
    const harness = createHarness({
      loadNearby: async () => {
        attempt += 1
        if (attempt === 1) throw error
        return [place(1)]
      },
    })
    const loadRequest = request({ origin: [24.5, 120.5], radiusMeters: 300 })

    await expect(harness.controller.load(loadRequest)).resolves.toBe(false)
    expect(harness.failures).toEqual([{ ...loadRequest, error }])
    await expect(harness.controller.retry()).resolves.toBe(true)
    expect(harness.starts).toEqual([loadRequest, loadRequest])
    expect(harness.presentations[0].places).toEqual([place(1)])
  })

  it('does not start for a different or missing city and rejects invalid limits', async () => {
    const harness = createHarness()
    harness.setCityCode('NewTaipei')
    await expect(harness.controller.load(request())).resolves.toBe(false)
    harness.setCityCode(undefined)
    await expect(harness.controller.load(request())).resolves.toBe(false)
    expect(harness.loadNearby).not.toHaveBeenCalled()
    await expect(harness.controller.retry()).resolves.toBe(false)

    expect(() => createHarness({ placeLimit: 0 })).toThrow('positive integer')
  })
})
