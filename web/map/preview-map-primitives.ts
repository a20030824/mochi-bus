import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import type { RouteMapVariant } from './map-api-client'
import { stopHaloColor } from './theme'

export type SelectablePreviewLine = {
  line: LeafletGeoJSON
  target: LeafletGeoJSON
}

export type SelectablePreviewLineRenderer = (
  shape: RouteMapVariant['shape'],
  pane: string,
  layer: L.LayerGroup,
  style: L.PathOptions,
) => SelectablePreviewLine

export type PreviewStopDotManager = {
  add(stops: RouteMapVariant['stops'], color: string, layer: L.LayerGroup): void
  resize(): void
  reset(): void
}

type SelectablePreviewLineRendererOptions = {
  hoverCapable: boolean
  touchHitWeight?: number
}

type PreviewStopDotManagerOptions = {
  map: L.Map
  pane?: string
  haloColor?: string
  className?: string
}

// Mouse pointers interact with the visible SVG path so hover enters and leaves exactly
// under the cursor. Touch gets the same visible path plus a transparent wide hit path.
export function createSelectablePreviewLineRenderer(
  options: SelectablePreviewLineRendererOptions,
): SelectablePreviewLineRenderer {
  const touchHitWeight = options.touchHitWeight ?? 26
  if (!Number.isFinite(touchHitWeight) || touchHitWeight <= 0) {
    throw new Error('Preview touch hit weight must be positive')
  }

  return (shape, pane, layer, style) => {
    if (options.hoverCapable) {
      const line = L.geoJSON(shape, { pane, style }).addTo(layer)
      return { line, target: line }
    }
    const line = L.geoJSON(shape, {
      pane,
      style: { ...style, interactive: false },
    }).addTo(layer)
    const target = L.geoJSON(shape, {
      pane,
      style: {
        color: '#000',
        opacity: 0,
        weight: touchHitWeight,
        lineCap: 'round',
        lineJoin: 'round',
      },
    }).addTo(layer)
    return { line, target }
  }
}

// A manager tracks only the dots created through itself. Different preview surfaces can
// therefore share one Leaflet layer without retaining or resizing each other's markers.
export function createPreviewStopDotManager(
  options: PreviewStopDotManagerOptions,
): PreviewStopDotManager {
  const pane = options.pane ?? 'previewDotPane'
  const haloColor = options.haloColor ?? stopHaloColor
  const className = options.className ?? 'preview-stop-dot'
  const dots = new Set<L.CircleMarker>()

  return {
    add(stops, color, layer) {
      const { radius, weight } = previewDotStyleForZoom(options.map.getZoom())
      L.geoJSON(stops, {
        pane,
        pointToLayer: (_feature, latlng) => {
          const dot = L.circleMarker(latlng, {
            pane,
            radius,
            weight,
            color: haloColor,
            fillColor: color,
            fillOpacity: .6,
            className,
            interactive: false,
          })
          dots.add(dot)
          return dot
        },
      }).addTo(layer)
    },
    resize() {
      const style = previewDotStyleForZoom(options.map.getZoom())
      for (const dot of dots) {
        if (!options.map.hasLayer(dot)) {
          dots.delete(dot)
          continue
        }
        dot.setStyle(style)
      }
    },
    reset() {
      dots.clear()
    },
  }
}

export function previewDotStyleForZoom(zoom: number): { radius: number; weight: number } {
  if (zoom >= 16) return { radius: 5, weight: 1.4 }
  if (zoom >= 14) return { radius: 3.5, weight: 1.2 }
  if (zoom >= 12) return { radius: 2.4, weight: 1 }
  return { radius: 1.8, weight: 1 }
}
