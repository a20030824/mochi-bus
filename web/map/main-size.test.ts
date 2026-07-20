/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import mainSource from './main.ts?raw'
import journeyPreviewSource from './journey-preview-controller.ts?raw'
import journeyPreviewMapSource from './journey-preview-map.ts?raw'
import previewMapPrimitivesSource from './preview-map-primitives.ts?raw'
import placeRoutesSource from './place-routes-controller.ts?raw'
import placeRoutesViewSource from './place-routes-view.ts?raw'
import nearbyPlacesViewSource from './nearby-places-view.ts?raw'
import routeDetailSurfaceSource from './route-detail-surface.ts?raw'

const MAP_MAIN_LINE_LIMIT = 1802

const TRIP_TRANSITION_CALLS = [
  'trip.start(',
  'trip.reset(',
  'trip.clearPending(',
  'trip.focus(',
  'trip.reselect(',
  'trip.selectEndpoint(',
  'trip.setPending(',
  'trip.setWarning(',
  'trip.completeDirect(',
  'trip.completeTransfer(',
  'trip.completeEmpty(',
  'trip.selectDirect(',
  'trip.selectTransfer(',
  'trip.begin(',
  'trip.restore(',
]

describe('map main architecture boundary', () => {
  it('does not grow without extracting another responsibility', () => {
    const lineCount = mainSource.split(/\r?\n/).length
    expect(lineCount).toBeLessThanOrEqual(MAP_MAIN_LINE_LIMIT)
  })

  it('delegates Trip preview orchestration to the Journey preview controller', () => {
    expect(mainSource).toContain('createJourneyPreviewController')
    expect(mainSource).not.toContain('function previewDirectRoutes(')
    expect(mainSource).not.toContain('function previewTransferPlans(')
    expect(mainSource).not.toContain('selectDirectPreviewEntries')
    for (const dependency of ['leaflet', 'history.', 'document.', 'window.', 'mapApi.', 'camera.']) {
      expect(journeyPreviewSource).not.toContain(dependency)
    }
  })

  it('delegates Leaflet Trip preview drawing to the Journey preview map surface', () => {
    expect(mainSource).toContain('createJourneyPreviewMap')
    expect(mainSource).not.toContain('function renderJourneyPreviewLeg(')
    expect(mainSource).not.toContain('getJourneySegmentCoordinates')
    for (const dependency of ['mapApi.', 'history.', 'camera.', 'trip.', 'document.', 'window.', 'loadVariant']) {
      expect(journeyPreviewMapSource).not.toContain(dependency)
    }
  })

  it('shares low-level preview lines and stop dots through preview map primitives', () => {
    expect(mainSource).toContain('createSelectablePreviewLineRenderer')
    expect(mainSource).toContain('createPreviewStopDotManager')
    expect(mainSource).not.toContain('function bindSelectableLine(')
    expect(mainSource).not.toContain('function addPreviewStopDots(')
    expect(mainSource).not.toContain('new Set<L.CircleMarker>()')
    expect(journeyPreviewMapSource).not.toContain('function bindSelectableLine(')
    expect(journeyPreviewMapSource).not.toContain('function addStopDots(')
    expect(journeyPreviewMapSource).not.toContain('previewDotStyleForZoom')
    expect(routeDetailSurfaceSource).toContain('SelectablePreviewLineRenderer')
    expect(routeDetailSurfaceSource).toContain('PreviewStopDotManager')
    for (const source of [mainSource, journeyPreviewMapSource, routeDetailSurfaceSource]) {
      expect(source).not.toContain('weight: 26')
      expect(source).not.toContain("'preview-stop-dot'")
    }
    expect(previewMapPrimitivesSource).toContain('weight: touchHitWeight')
    expect(previewMapPrimitivesSource).toContain("'preview-stop-dot'")
    for (const dependency of [
      'mapApi.',
      'history.',
      'camera.',
      'trip.',
      'document.',
      'window.',
      'loadVariant',
      'journey-preview',
      'route-detail',
      './main',
    ]) {
      expect(previewMapPrimitivesSource).not.toContain(dependency)
    }
  })

  it('delegates Place route loading, ranking, and preview completion to the Place routes controller', () => {
    expect(mainSource).toContain('createPlaceRoutesController')
    expect(mainSource).not.toContain('async function previewPlaceRoutes(')
    expect(mainSource).not.toContain('function placeRouteRank(')
    expect(mainSource).not.toContain('beginOtherPreviewRequest')
    expect(mainSource).not.toContain('previewRequest')
    expect(mainSource).not.toContain('await mapApi.placeRoutes(')
    expect(placeRoutesSource).toContain('options.onRoutes(presentation)')
    expect(placeRoutesSource).toContain('options.renderPreview(preview)')
    expect(placeRoutesSource).toContain('options.onComplete(presentation)')
    for (const dependency of [
      'leaflet',
      'history.',
      'document.',
      'window.',
      'camera.',
      'trip.',
      'drawer',
      'readBoards',
      'mapApi.',
      'journey-preview',
      'route-detail',
      './main',
      'AbortController',
      'setStatus(',
      'renderDrawer(',
      'isTdxTokenRejectedError',
      'tdxWarningMessages',
      'toggleFavoriteDirection',
    ]) {
      expect(placeRoutesSource).not.toContain(dependency)
    }
  })

  it('delegates Place route Drawer presentation to the Place routes view', () => {
    expect(mainSource).toContain('createPlaceRoutesView')
    expect(mainSource).toContain('placeRoutesView.renderLoading(start)')
    expect(mainSource).toContain('onRoutes: placeRoutesView.renderRoutes')
    expect(mainSource).toContain('placeRoutesView.renderError(failure)')
    expect(mainSource).not.toContain('function renderPlaceRoutesLoading(')
    expect(mainSource).not.toContain('function renderPlaceRoutes(')
    expect(mainSource).not.toContain('function renderPlaceRoutesError(')
    expect(mainSource).not.toContain('function etaPresentationNode(')
    for (const marker of [
      "className = 'place-route-list'",
      "className = 'place-route-row'",
      "className = 'place-route-button'",
      "className = 'place-route-main'",
      "className = 'eta-freshness'",
    ]) {
      expect(mainSource).not.toContain(marker)
    }
    expect(placeRoutesViewSource).toContain('createPlaceRoutesView')
    expect(placeRoutesViewSource).toContain("className = 'place-route-list'")
    expect(placeRoutesViewSource).toContain('options.createFavoriteControl(place, route)')
    expect(placeRoutesViewSource).toContain('options.onOpenRoute(')
    expect(placeRoutesViewSource).toContain('options.onRetry(place)')
    expect(placeRoutesViewSource).toContain('etaPresentation(route.etaLabel')
    expect(placeRoutesViewSource).toContain('tdxWarningMessages[warning]')
    for (const dependency of [
      'leaflet',
      'history.',
      'camera.',
      'trip.',
      'mapApi.',
      'routeDetail',
      'readBoards',
      'toggleFavoriteDirection',
      'isFavoriteDirection',
      'placeRoutes.open',
      'setStatus(',
      'clearStatus(',
      'createPlaceRoutesController',
      'boards/store',
      './main',
    ]) {
      expect(placeRoutesViewSource).not.toContain(dependency)
    }
  })

  it('delegates Nearby Places Drawer presentation to the Nearby places view', () => {
    expect(mainSource).toContain('createNearbyPlacesView')
    expect(mainSource).toContain('nearbyPlacesView.renderLoading({')
    expect(mainSource).toContain('nearbyPlacesView.renderPlaces({')
    expect(mainSource).toContain('nearbyPlacesView.renderError({')
    expect(mainSource).toContain('onOpenPlace: (place) => void openNearbyPlace(place)')
    const renderPlacesIndex = mainSource.indexOf('nearbyPlacesView.renderPlaces({')
    expect(mainSource.indexOf('clearStatus()', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    expect(mainSource.indexOf('history.replaceState', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    expect(mainSource.indexOf('setDocumentTitle', renderPlacesIndex)).toBeGreaterThan(renderPlacesIndex)
    for (const marker of [
      "className = 'nearby-list'",
      "className = 'nearby-place-button'",
      '正在搜尋附近站牌',
      '500 公尺內沒有收錄到站牌',
      '附近站牌讀取失敗',
    ]) expect(mainSource).not.toContain(marker)
    expect(nearbyPlacesViewSource).toContain('createNearbyPlacesView')
    expect(nearbyPlacesViewSource).toContain("className = 'nearby-list'")
    expect(nearbyPlacesViewSource).toContain('options.onOpenPlace(place)')
    expect(nearbyPlacesViewSource).toContain('options.createRetryButton(onRetry)')
    expect(nearbyPlacesViewSource).toContain('options.createTripModeButton()')
    expect(nearbyPlacesViewSource).toContain('drawerKey(cityCode, origin)')
    expect(nearbyPlacesViewSource).toContain('options.createBackButton(backLabel, onBack)')
    for (const dependency of [
      'leaflet', 'history.', 'window.', 'mapApi.', 'camera.', 'trip.', 'routeDetail',
      'cityNetwork', 'nearbyLayer', 'beginNavRequest', 'isStaleNav', 'setStatus(',
      'clearStatus(', 'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',
      'openNearbyPlace', 'findNearbyPlaces', 'renderNearbyPlaces', './main',
    ]) expect(nearbyPlacesViewSource).not.toContain(dependency)
  })

  it('delegates Trip result Drawer construction to the Trip results view', () => {
    expect(mainSource).toContain('createTripResultsView')
    expect(mainSource).not.toContain("className = 'direct-route-list'")
    expect(mainSource).not.toContain("className = 'transfer-plan-list'")
    expect(mainSource).not.toContain('function renderDirectRoutes(')
    expect(mainSource).not.toContain('function renderTransferPlans(')
  })

  it('delegates Trip state transitions to the Trip controller', () => {
    expect(mainSource).toContain('createTripController')
    for (const call of TRIP_TRANSITION_CALLS) expect(mainSource).not.toContain(call)
  })
})
