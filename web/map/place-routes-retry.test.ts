import { describe, expect, it, vi } from 'vitest'
import type { NearbyPlace, PlaceArrivalsResponse, PlaceRoute } from './map-api-client'
import { createPlaceRoutesController } from './place-routes-controller'

const place: NearbyPlace = {
  placeId: 'PLACE',
  name: '測試站牌',
  latitude: 25,
  longitude: 121,
  distanceMeters: 120,
}

const route: PlaceRoute = {
  routeUid: 'TPE-307',
  routeName: '307',
  variantKey: '307:0',
  direction: 0,
  label: '往板橋',
  subRouteName: '307',
  stopUid: 'TPE-STOP',
  stopName: '測試站牌',
  stopSequence: 1,
  estimateSeconds: 60,
  etaLabel: '1 分',
  stopStatus: 0,
}

type Scheduled = { callback: () => void; delayMs: number; cancelled: boolean }

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function createHarness(loadRoutes: () => Promise<PlaceArrivalsResponse>) {
  let requestId = 0
  const scheduled: Scheduled[] = []
  const errors: unknown[] = []
  const routes: PlaceArrivalsResponse[] = []
  const controller = createPlaceRoutesController({
    currentCityCode: () => 'Taipei',
    beginRequest: () => ({ requestId: ++requestId, signal: new AbortController().signal }),
    isStaleRequest: (candidate) => candidate !== requestId,
    loadRoutes,
    loadVariant: async () => undefined,
    favoriteRouteUids: () => [],
    routeColor: () => '#000',
    clearPreview: () => undefined,
    invalidateOtherPreviews: () => undefined,
    onStart: () => undefined,
    onRoutes: (presentation) => routes.push({
      routes: presentation.routes.map((entry) => entry.route),
      warning: presentation.warning,
    }),
    renderPreview: () => undefined,
    onComplete: () => undefined,
    onError: ({ error }) => errors.push(error),
    scheduleRetry: (callback, delayMs) => {
      const timer = { callback, delayMs, cancelled: false }
      scheduled.push(timer)
      return timer as unknown as ReturnType<typeof setTimeout>
    },
    cancelRetry: (timer) => {
      (timer as unknown as Scheduled).cancelled = true
    },
  })
  return { controller, scheduled, errors, routes }
}

describe('Place routes quiet retries', () => {
  it('stays on loading for the first failure, reveals the second, then recovers silently', async () => {
    const first = new TypeError('offline')
    const second = new TypeError('still offline')
    const loadRoutes = vi.fn()
      .mockRejectedValueOnce(first)
      .mockRejectedValueOnce(second)
      .mockResolvedValueOnce({ routes: [route] })
    const harness = createHarness(loadRoutes)

    await expect(harness.controller.open(place)).resolves.toBe(false)
    expect(harness.errors).toEqual([])
    expect(harness.scheduled.map((timer) => timer.delayMs)).toEqual([3_000])

    harness.scheduled[0].callback()
    await flush()
    expect(harness.errors).toEqual([second])
    expect(harness.scheduled.map((timer) => timer.delayMs)).toEqual([3_000, 30_000])

    harness.scheduled[1].callback()
    await flush()
    expect(harness.routes).toEqual([{ routes: [route], warning: undefined }])
    expect(harness.errors).toEqual([second])
    expect(loadRoutes).toHaveBeenCalledTimes(3)
  })

  it('cancels a pending retry when the Place workflow is invalidated', async () => {
    const harness = createHarness(async () => { throw new TypeError('offline') })

    await harness.controller.open(place)
    expect(harness.scheduled).toHaveLength(1)
    harness.controller.cancel()
    expect(harness.scheduled[0].cancelled).toBe(true)

    harness.scheduled[0].callback()
    await flush()
    expect(harness.scheduled).toHaveLength(1)
  })
})
