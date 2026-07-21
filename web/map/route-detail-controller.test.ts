import { describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant, RouteTimetableResponse } from './map-api-client'
import {
  createRouteDetailController,
  type RouteDetailOpenRequest,
} from './route-detail-controller'
import type { RouteDetailSurface } from './route-detail-surface'

const firstVariant = variant('northbound')
const secondVariant = variant('southbound')

function variant(key: string): RouteMapVariant {
  return {
    variantKey: key,
    routeName: '307',
    routeUid: 'TPE307',
    direction: key === 'northbound' ? 0 : 1,
    label: key,
    subRouteName: '307',
    shape: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25.1]] },
    },
    stops: { type: 'FeatureCollection', features: [] },
    updatedAt: null,
  }
}

function timetable(): RouteTimetableResponse {
  return {
    schemaVersion: 1,
    city: 'Taipei',
    routeName: '307',
    variantKey: firstVariant.variantKey,
    routeUid: firstVariant.routeUid,
    direction: firstVariant.direction,
    source: 'snapshot',
    timetable: {
      mode: 'departure',
      selectedStop: null,
      departureStop: null,
      stops: [],
      timedStopCount: 1,
      services: [{
        id: 'weekday',
        label: '平日',
        days: [1, 2, 3, 4, 5],
        today: true,
        times: ['08:00'],
        periods: [],
        firstTime: '08:00',
        lastTime: '08:00',
      }],
    },
  }
}

type Harness = ReturnType<typeof createHarness>

function createHarness(
  loadVariants: (
    cityCode: string,
    routeName: string,
    signal?: AbortSignal,
  ) => Promise<RouteMapVariant[]> = vi.fn(async () => [firstVariant]),
) {
  let requestId = 0
  let currentController: AbortController | undefined
  let pickerOptions: Parameters<RouteDetailSurface['showVariantPicker']>[0] | undefined
  let routeOptions: Parameters<RouteDetailSurface['showRoute']>[0] | undefined
  let timetableBack: (() => void) | undefined

  const surface: RouteDetailSurface = {
    showRouteLoading: vi.fn(),
    showRouteError: vi.fn(),
    showVariantPicker: vi.fn((options) => { pickerOptions = options }),
    showRoute: vi.fn((options) => {
      routeOptions = options
      return {} as HTMLButtonElement
    }),
    showTimetableLoading: vi.fn((_city, _variant, _stop, onBack) => { timetableBack = onBack }),
    showTimetableError: vi.fn(),
    showTimetable: vi.fn(() => ({ available: true })),
    renderVehicles: vi.fn(),
    clearRoute: vi.fn(),
    clearSelection: vi.fn(),
    clearVehicles: vi.fn(),
    resizeStopMarkers: vi.fn(),
  }
  const options = {
    surface,
    loadVariants,
    loadTimetable: vi.fn(async () => timetable()),
    beginRequest: vi.fn(() => {
      currentController?.abort()
      currentController = new AbortController()
      return { requestId: ++requestId, signal: currentController.signal }
    }),
    isStaleRequest: vi.fn((candidate: number) => candidate !== requestId),
    isCityActive: vi.fn((cityCode: string) => cityCode === 'Taipei'),
    prepareOpen: vi.fn(),
    invalidatePreview: vi.fn(),
    clearNearby: vi.fn(),
    clearPreview: vi.fn(),
    enterRouteMode: vi.fn(),
    clearTripState: vi.fn(),
    hasTripResults: vi.fn(() => false),
    returnToTripResults: vi.fn(),
    returnToRoutePicker: vi.fn(),
    onStopSelect: vi.fn(),
    writePickerLocation: vi.fn(),
    writeVariantLocation: vi.fn(),
    setDocumentTitle: vi.fn(),
    setStatus: vi.fn(),
    clearStatus: vi.fn(),
    startVehicleRefresh: vi.fn(),
    stopVehicleRefresh: vi.fn(),
    startTimetableSummary: vi.fn(),
    stopTimetableSummary: vi.fn(),
  }
  const controller = createRouteDetailController(options)
  return {
    controller,
    options,
    surface,
    pickerOptions: () => pickerOptions,
    routeOptions: () => routeOptions,
    timetableBack: () => timetableBack,
  }
}

const request: RouteDetailOpenRequest = {
  cityCode: 'Taipei',
  routeName: '307',
  color: '#c43d3d',
}

describe('route detail controller', () => {
  it('opens a single variant and owns its route enhancements', async () => {
    const harness = createHarness()

    await harness.controller.open(request)

    expect(harness.options.prepareOpen).toHaveBeenCalledWith({ ...request, returnToTrip: false })
    expect(harness.surface.showRouteLoading).toHaveBeenCalledOnce()
    expect(harness.surface.showRoute).toHaveBeenCalledOnce()
    expect(harness.options.enterRouteMode).toHaveBeenCalledOnce()
    expect(harness.options.clearTripState).toHaveBeenCalledOnce()
    expect(harness.options.startTimetableSummary).toHaveBeenCalledWith(
      'Taipei',
      firstVariant,
      expect.anything(),
    )
    expect(harness.options.startVehicleRefresh).toHaveBeenCalledWith('Taipei', firstVariant)
    expect(harness.options.writeVariantLocation).toHaveBeenCalledWith('Taipei', firstVariant, undefined)
    expect(harness.controller.isVehicleSessionActive({ cityCode: 'Taipei', route: firstVariant })).toBe(true)
  })

  it('keeps variant choices in the session and returns to the picker', async () => {
    const harness = createHarness(vi.fn(async () => [firstVariant, secondVariant]))

    await harness.controller.open(request)
    expect(harness.surface.showVariantPicker).toHaveBeenCalledOnce()
    expect(harness.options.startVehicleRefresh).not.toHaveBeenCalled()

    harness.pickerOptions()?.onSelect(secondVariant)
    expect(harness.surface.showRoute).toHaveBeenCalledOnce()
    expect(harness.options.startVehicleRefresh).toHaveBeenCalledWith('Taipei', secondVariant)

    harness.routeOptions()?.onBack()
    expect(harness.surface.showVariantPicker).toHaveBeenCalledTimes(2)
    expect(harness.options.stopVehicleRefresh).toHaveBeenCalled()
    expect(harness.options.writePickerLocation).toHaveBeenLastCalledWith('Taipei', '307', undefined)
  })

  it('discards a late variant response after a newer route session starts', async () => {
    let resolveFirst: ((variants: RouteMapVariant[]) => void) | undefined
    const loadVariants = vi.fn((_: string, routeName: string) => routeName === 'old'
      ? new Promise<RouteMapVariant[]>((resolve) => { resolveFirst = resolve })
      : Promise.resolve([secondVariant]))
    const harness = createHarness(loadVariants)

    const oldOpen = harness.controller.open({ ...request, routeName: 'old' })
    await harness.controller.open({ ...request, routeName: 'new' })
    resolveFirst?.([firstVariant])
    await oldOpen

    expect(harness.surface.showRoute).toHaveBeenCalledTimes(1)
    expect(harness.options.startVehicleRefresh).toHaveBeenCalledWith('Taipei', secondVariant)
  })

  it('stops route enhancements while timetable is open and restores them on Back', async () => {
    const harness = createHarness()
    await harness.controller.open(request)
    harness.options.stopVehicleRefresh.mockClear()
    harness.options.stopTimetableSummary.mockClear()

    await harness.controller.openTimetable()

    expect(harness.options.stopVehicleRefresh).toHaveBeenCalledOnce()
    expect(harness.options.stopTimetableSummary).toHaveBeenCalledOnce()
    expect(harness.options.loadTimetable).toHaveBeenCalledWith(
      'Taipei',
      firstVariant,
      undefined,
      expect.any(AbortSignal),
    )
    expect(harness.surface.showTimetable).toHaveBeenCalledOnce()
    expect(harness.controller.isVehicleSessionActive({ cityCode: 'Taipei', route: firstVariant })).toBe(false)

    harness.timetableBack()?.()
    expect(harness.options.startVehicleRefresh).toHaveBeenCalledTimes(2)
    expect(harness.controller.isVehicleSessionActive({ cityCode: 'Taipei', route: firstVariant })).toBe(true)
  })

  it('defaults the timetable to the place stop and remembers a later stop selection', async () => {
    const harness = createHarness()
    await harness.controller.open({ ...request, preferredTimetableStopUid: 'STOP-A' })

    await harness.controller.openTimetable()
    expect(harness.options.loadTimetable).toHaveBeenLastCalledWith(
      'Taipei',
      firstVariant,
      'STOP-A',
      expect.any(AbortSignal),
    )

    await harness.controller.openTimetable('STOP-B')
    await harness.controller.openTimetable()
    expect(harness.options.loadTimetable).toHaveBeenLastCalledWith(
      'Taipei',
      firstVariant,
      'STOP-B',
      expect.any(AbortSignal),
    )
    expect(harness.options.writeVariantLocation).toHaveBeenLastCalledWith('Taipei', firstVariant, 'STOP-B')
  })

  it('closes the session and clears route-owned surfaces', async () => {
    const harness = createHarness()
    await harness.controller.open(request)

    harness.controller.close()

    expect(harness.options.stopVehicleRefresh).toHaveBeenCalled()
    expect(harness.options.stopTimetableSummary).toHaveBeenCalled()
    expect(harness.surface.clearRoute).toHaveBeenCalled()
    expect(harness.surface.clearSelection).toHaveBeenCalled()
    expect(harness.controller.isVehicleSessionActive({ cityCode: 'Taipei', route: firstVariant })).toBe(false)
  })
})
