import { beforeEach, describe, expect, it, vi } from 'vitest'

const leaflet = vi.hoisted(() => ({
  geoJSON: vi.fn(),
  circleMarker: vi.fn(),
}))

vi.mock('leaflet', () => ({
  default: {
    geoJSON: leaflet.geoJSON,
    circleMarker: leaflet.circleMarker,
  },
}))

import {
  createPreviewStopDotManager,
  createSelectablePreviewLineRenderer,
  previewDotStyleForZoom,
} from './preview-map-primitives'

const shape = {
  type: 'Feature' as const,
  properties: {},
  geometry: {
    type: 'LineString' as const,
    coordinates: [[121, 25], [121.1, 25.1]],
  },
}

function addable() {
  const layer = { addTo: vi.fn() }
  layer.addTo.mockReturnValue(layer)
  return layer
}

beforeEach(() => {
  leaflet.geoJSON.mockReset()
  leaflet.circleMarker.mockReset()
})

describe('preview map primitives', () => {
  it('uses the visible line as the desktop interaction target', () => {
    const line = addable()
    const layerGroup = {}
    const style = { color: '#123', weight: 5 }
    leaflet.geoJSON.mockReturnValue(line)

    const render = createSelectablePreviewLineRenderer({ hoverCapable: true })
    const result = render(shape, 'routePreviewPane', layerGroup as never, style)

    expect(result).toEqual({ line, target: line })
    expect(leaflet.geoJSON).toHaveBeenCalledOnce()
    expect(leaflet.geoJSON).toHaveBeenCalledWith(shape, {
      pane: 'routePreviewPane',
      style,
    })
    expect(line.addTo).toHaveBeenCalledWith(layerGroup)
  })

  it('adds a transparent wide touch target without making the visible line interactive', () => {
    const line = addable()
    const target = addable()
    const layerGroup = {}
    const style = { color: '#123', weight: 5, opacity: .62 }
    leaflet.geoJSON.mockReturnValueOnce(line).mockReturnValueOnce(target)

    const render = createSelectablePreviewLineRenderer({ hoverCapable: false })
    const result = render(shape, 'routePreviewPane', layerGroup as never, style)

    expect(result).toEqual({ line, target })
    expect(leaflet.geoJSON).toHaveBeenNthCalledWith(1, shape, {
      pane: 'routePreviewPane',
      style: { ...style, interactive: false },
    })
    expect(leaflet.geoJSON).toHaveBeenNthCalledWith(2, shape, {
      pane: 'routePreviewPane',
      style: {
        color: '#000',
        opacity: 0,
        weight: 26,
        lineCap: 'round',
        lineJoin: 'round',
      },
    })
  })

  it('tracks, resizes, forgets stale dots, and can reset its own marker set', () => {
    let zoom = 14
    let visible = true
    const dot = { setStyle: vi.fn() }
    const collection = addable()
    const map = {
      getZoom: () => zoom,
      hasLayer: () => visible,
    }
    const layerGroup = {}
    const stops = { type: 'FeatureCollection', features: [] }
    leaflet.circleMarker.mockReturnValue(dot)
    leaflet.geoJSON.mockImplementation((_data, options) => {
      options.pointToLayer({}, { lat: 25, lng: 121 })
      return collection
    })

    const manager = createPreviewStopDotManager({ map: map as never })
    manager.add(stops as never, '#456', layerGroup as never)

    expect(leaflet.circleMarker).toHaveBeenCalledWith(
      { lat: 25, lng: 121 },
      expect.objectContaining({
        pane: 'previewDotPane',
        radius: 3.5,
        weight: 1.2,
        fillColor: '#456',
        interactive: false,
      }),
    )
    expect(collection.addTo).toHaveBeenCalledWith(layerGroup)

    zoom = 16
    manager.resize()
    expect(dot.setStyle).toHaveBeenCalledWith({ radius: 5, weight: 1.4 })

    visible = false
    manager.resize()
    visible = true
    manager.resize()
    expect(dot.setStyle).toHaveBeenCalledTimes(1)

    manager.add(stops as never, '#789', layerGroup as never)
    manager.reset()
    manager.resize()
    expect(dot.setStyle).toHaveBeenCalledTimes(1)
  })

  it('preserves the existing preview-dot zoom scale', () => {
    expect(previewDotStyleForZoom(11)).toEqual({ radius: 1.8, weight: 1 })
    expect(previewDotStyleForZoom(12)).toEqual({ radius: 2.4, weight: 1 })
    expect(previewDotStyleForZoom(14)).toEqual({ radius: 3.5, weight: 1.2 })
    expect(previewDotStyleForZoom(16)).toEqual({ radius: 5, weight: 1.4 })
  })

  it('rejects invalid touch hit widths', () => {
    expect(() => createSelectablePreviewLineRenderer({ hoverCapable: false, touchHitWeight: 0 }))
      .toThrow('Preview touch hit weight must be positive')
  })
})
