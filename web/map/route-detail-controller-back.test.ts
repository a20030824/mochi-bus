import { describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant } from './map-api-client'
import { createRouteDetailController } from './route-detail-controller'
import type { RouteDetailSurface } from './route-detail-surface'

const variant: RouteMapVariant = {
  variantKey: '307:0',
  routeName: '307',
  routeUid: 'TPE307',
  direction: 0,
  label: '板橋 → 撫遠街',
  subRouteName: '307',
  shape: {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25.1]] },
  },
  stops: { type: 'FeatureCollection', features: [] },
  updatedAt: null,
}

describe('route detail Back contract', () => {
  it('degrades a stale trip-results Back target at click time', async () => {
    let routeBack: (() => void) | undefined
    let tripResultsAvailable = true
    const returnToTripResults = vi.fn()
    const returnToRoutePicker = vi.fn()
    const surface: RouteDetailSurface = {
      showRouteLoading: vi.fn(),
      showRouteError: vi.fn(),
      showVariantPicker: vi.fn(),
      showRoute: vi.fn((options) => {
        routeBack = options.onBack
        return {} as HTMLButtonElement
      }),
      showTimetableLoading: vi.fn(),
      showTimetableError: vi.fn(),
      showTimetable: vi.fn(() => ({ available: true })),
      renderVehicles: vi.fn(),
      clearRoute: vi.fn(),
      clearSelection: vi.fn(),
      clearVehicles: vi.fn(),
      resizeStopMarkers: vi.fn(),
    }
    let requestId = 0
    const controller = createRouteDetailController({
      surface,
      loadVariants: vi.fn(async () => [variant]),
      loadTimetable: vi.fn(),
      beginRequest: () => ({ requestId: ++requestId, signal: new AbortController().signal }),
      isStaleRequest: (candidate) => candidate !== requestId,
      isCityActive: (cityCode) => cityCode === 'Taipei',
      prepareOpen: vi.fn(),
      invalidatePreview: vi.fn(),
      clearNearby: vi.fn(),
      clearPreview: vi.fn(),
      enterRouteMode: vi.fn(),
      clearTripState: vi.fn(),
      hasTripResults: () => tripResultsAvailable,
      returnToTripResults,
      returnToRoutePicker,
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
    })

    await controller.open({
      cityCode: 'Taipei',
      routeName: '307',
      preferredVariant: variant.variantKey,
      returnToTrip: true,
      color: '#c43d3d',
    })

    expect(routeBack).toBeTypeOf('function')
    tripResultsAvailable = false
    routeBack?.()

    expect(returnToTripResults).not.toHaveBeenCalled()
    expect(returnToRoutePicker).toHaveBeenCalledOnce()
  })
})
