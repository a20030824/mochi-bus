import { describe, expect, it, vi } from 'vitest'
import {
  captureMapCamera,
  journeyPreviewCamera,
  restoreMapCamera,
  type MapCameraAdapter,
} from './journey-camera'

function setupMap(): MapCameraAdapter & { center: { lat: number; lng: number }; zoom: number } {
  const map = {
    center: { lat: 25.033, lng: 121.565 },
    zoom: 14,
    getCenter() { return this.center },
    getZoom() { return this.zoom },
    setView: vi.fn(),
  }
  return map
}

describe('journey camera lifecycle', () => {
  it('captures serializable center and zoom and restores without animation', () => {
    const map = setupMap()
    const state = captureMapCamera(map)
    map.center = { lat: 24.1, lng: 120.6 }
    map.zoom = 8

    restoreMapCamera(map, state)

    expect(state).toEqual({ center: [25.033, 121.565], zoom: 14 })
    expect(map.setView).toHaveBeenCalledWith([25.033, 121.565], 14, { animate: false })
  })

  it.each([
    ['initial result', 'initial', { fitCamera: true, restoreCamera: false }],
    ['candidate switch', 'selection', { fitCamera: true, restoreCamera: false }],
    ['return from route detail', 'return', { fitCamera: false, restoreCamera: true }],
    ['plain rerender', 'rerender', { fitCamera: false, restoreCamera: false }],
  ] as const)('%s has an explicit camera decision', (_label, kind, expected) => {
    expect(journeyPreviewCamera(kind)).toEqual(expected)
  })
})
