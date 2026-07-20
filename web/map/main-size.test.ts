/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import mainSource from './main.ts?raw'
import journeyPreviewSource from './journey-preview-controller.ts?raw'

const MAP_MAIN_LINE_LIMIT = 2072

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
