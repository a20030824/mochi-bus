import { describe, expect, it, vi } from 'vitest'

vi.mock('leaflet', () => ({ default: {} }))
import type { RouteMapVariant } from './map-api-client'
import { resolveJourneyPreviewGeometry } from './journey-preview-map'

function variant(): RouteMapVariant {
  return {
    variantKey: '307:0',
    routeName: '307',
    routeUid: 'TPE-307',
    direction: 0,
    label: '往撫遠街',
    subRouteName: '307',
    shape: {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'LineString',
        coordinates: [
          [121.0000, 25.0000],
          [121.0100, 25.0100],
          [121.0200, 25.0200],
          [121.0300, 25.0300],
        ],
      },
    },
    stops: {
      type: 'FeatureCollection',
      features: [
        stop(1, '起點', 121.0000, 25.0000),
        stop(2, '上車站', 121.0100, 25.0100),
        stop(3, '下車站', 121.0200, 25.0200),
        stop(4, '終點', 121.0300, 25.0300),
      ],
    },
    updatedAt: null,
  }
}

function stop(sequence: number, stopName: string, longitude: number, latitude: number) {
  return {
    type: 'Feature' as const,
    properties: {
      stopUid: `stop-${sequence}`,
      stopName,
      sequence,
    },
    geometry: {
      type: 'Point' as const,
      coordinates: [longitude, latitude],
    },
  }
}

describe('Journey preview map geometry', () => {
  it('extracts the selected segment and latitude-longitude focus coordinates', () => {
    const geometry = resolveJourneyPreviewGeometry(variant(), 2, 3)

    expect(geometry.board?.properties.stopName).toBe('上車站')
    expect(geometry.alight?.properties.stopName).toBe('下車站')
    expect(geometry.segmentCoordinates).toEqual([
      [121.0100, 25.0100],
      [121.0200, 25.0200],
    ])
    expect(geometry.focusCoordinates).toEqual([
      [25.0100, 121.0100],
      [25.0200, 121.0200],
      [25.0100, 121.0100],
      [25.0200, 121.0200],
    ])
  })

  it('keeps any resolved endpoint focus when a complete segment cannot be built', () => {
    const geometry = resolveJourneyPreviewGeometry(variant(), 2, 99)

    expect(geometry.board?.properties.stopName).toBe('上車站')
    expect(geometry.alight).toBeUndefined()
    expect(geometry.segmentCoordinates).toBeUndefined()
    expect(geometry.focusCoordinates).toEqual([[25.0100, 121.0100]])
  })

})
