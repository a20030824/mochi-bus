/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import mainSource from './main.ts?raw'
import journeyPreviewSource from './journey-preview-controller.ts?raw'
import journeyPreviewMapSource from './journey-preview-map.ts?raw'
import previewMapPrimitivesSource from './preview-map-primitives.ts?raw'
import routeDetailSurfaceSource from './route-detail-surface.ts?raw'

const MAP_MAIN_LINE_LIMIT = 1950

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
