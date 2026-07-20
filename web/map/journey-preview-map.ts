import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { getJourneySegmentCoordinates } from '../../src/domain/map/journey-segment'
import { bindTextTooltip } from './leaflet-tooltip'
import { stopHaloColor } from './theme'
import type { JourneyPreviewLeg, JourneyPreviewRenderResult } from './journey-preview-controller'
import type { RouteMapVariant } from './map-api-client'
import type { TripCoordinate } from './trip-state'

type JourneyPreviewMapOptions = {
  map: L.Map
  layer: L.LayerGroup
  hoverCapable: boolean
  routePane?: string
  dotPane?: string
  stopPane?: string
}

export type JourneyPreviewGeometry = {
  board?: RouteMapVariant['stops']['features'][number]
  alight?: RouteMapVariant['stops']['features'][number]
  segmentCoordinates?: Array<[number, number]>
  focusCoordinates: TripCoordinate[]
}

export type JourneyPreviewMap = {
  renderLeg(leg: JourneyPreviewLeg): JourneyPreviewRenderResult
  resizeStopMarkers(): void
  reset(): void
}

// Leaflet-specific Trip drawing surface. Async loading, stale-request rejection, result
// selection, History and camera execution deliberately remain outside this module.
export function createJourneyPreviewMap(options: JourneyPreviewMapOptions): JourneyPreviewMap {
  const routePane = options.routePane ?? 'routePreviewPane'
  const dotPane = options.dotPane ?? 'previewDotPane'
  const stopPane = options.stopPane ?? 'stopPane'
  const stopDots = new Set<L.CircleMarker>()

  function bindHoverTooltip<T extends L.Layer>(layer: T, content: string, tooltipOptions?: L.TooltipOptions): T {
    if (options.hoverCapable) bindTextTooltip(layer, content, tooltipOptions)
    return layer
  }

  // Touch uses a transparent wide hit target; hover-capable pointers keep events on
  // the visible line so mouseover/mouseout follows the cursor precisely.
  function bindSelectableLine(
    shape: RouteMapVariant['shape'],
    style: L.PathOptions,
  ): { line: LeafletGeoJSON; target: LeafletGeoJSON } {
    if (options.hoverCapable) {
      const line = L.geoJSON(shape, { pane: routePane, style }).addTo(options.layer)
      return { line, target: line }
    }
    const line = L.geoJSON(shape, {
      pane: routePane,
      style: { ...style, interactive: false },
    }).addTo(options.layer)
    const target = L.geoJSON(shape, {
      pane: routePane,
      style: { color: '#000', opacity: 0, weight: 26, lineCap: 'round', lineJoin: 'round' },
    }).addTo(options.layer)
    return { line, target }
  }

  // Only the selected Trip leg receives stop dots. Track them separately from the
  // shared Place/route-detail dots so each surface can resize its own markers.
  function addStopDots(stops: RouteMapVariant['stops'], color: string): void {
    const { radius, weight } = previewDotStyleForZoom(options.map.getZoom())
    L.geoJSON(stops, {
      pane: dotPane,
      pointToLayer: (_feature, latlng) => {
        const dot = L.circleMarker(latlng, {
          pane: dotPane,
          radius,
          weight,
          color: stopHaloColor,
          fillColor: color,
          fillOpacity: .6,
          className: 'preview-stop-dot',
          interactive: false,
        })
        stopDots.add(dot)
        return dot
      },
    }).addTo(options.layer)
  }

  function addEndpointLabel(
    stop: RouteMapVariant['stops']['features'][number],
    label: string,
    color: string,
  ): void {
    const [longitude, latitude] = stop.geometry.coordinates
    const radius = options.map.getZoom() >= 16 ? 11 : 9
    const marker = L.circleMarker([latitude, longitude], {
      pane: stopPane,
      radius,
      color: stopHaloColor,
      weight: 2.4,
      fillColor: color,
      fillOpacity: .96,
    })
    bindTextTooltip(marker, `${label} · ${stop.properties.stopName}`, {
      permanent: true,
      direction: 'top',
    }).addTo(options.layer)
  }

  function renderLeg({
    variant,
    color,
    boardSequence,
    alightSequence,
    labels,
    selected,
    onSelect,
  }: JourneyPreviewLeg): JourneyPreviewRenderResult {
    const { target: fullLineTarget } = bindSelectableLine(variant.shape, {
      color,
      weight: selected ? 3.5 : 2.5,
      opacity: selected ? .18 : .08,
      lineCap: 'round',
      lineJoin: 'round',
    })
    bindHoverTooltip(fullLineTarget, `${variant.routeName} · ${variant.label}`, { sticky: true })
    fullLineTarget.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      onSelect()
    })

    const geometry = resolveJourneyPreviewGeometry(variant, boardSequence, alightSequence)
    let hasSegment = false
    if (geometry.segmentCoordinates && geometry.board && geometry.alight) {
      const segmentFeature: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates: geometry.segmentCoordinates },
      }
      const segment = L.geoJSON(segmentFeature, {
        pane: routePane,
        style: {
          color,
          weight: selected ? 7 : 4,
          opacity: selected ? .92 : .26,
          lineCap: 'round',
          lineJoin: 'round',
        },
      }).addTo(options.layer)
      bindHoverTooltip(
        segment,
        `${variant.routeName} · ${geometry.board.properties.stopName} → ${geometry.alight.properties.stopName}`,
        { sticky: true },
      )
      segment.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        onSelect()
      })
      hasSegment = true
    }

    if (geometry.board && geometry.alight && selected) {
      addStopDots(variant.stops, color)
      addEndpointLabel(geometry.board, labels[0], color)
      addEndpointLabel(geometry.alight, labels[1], color)
    }

    return {
      focusCoordinates: geometry.focusCoordinates,
      hasSegment,
    }
  }

  return {
    renderLeg,
    resizeStopMarkers() {
      const style = previewDotStyleForZoom(options.map.getZoom())
      for (const dot of stopDots) {
        if (!options.map.hasLayer(dot)) {
          stopDots.delete(dot)
          continue
        }
        dot.setStyle(style)
      }
    },
    reset() {
      stopDots.clear()
    },
  }
}

export function resolveJourneyPreviewGeometry(
  variant: RouteMapVariant,
  boardSequence: number,
  alightSequence: number,
): JourneyPreviewGeometry {
  const board = variant.stops.features.find((stop) => stop.properties.sequence === boardSequence)
  const alight = variant.stops.features.find((stop) => stop.properties.sequence === alightSequence)
  const coordinates = variant.shape.geometry.coordinates as Array<[number, number]>
  const stops = variant.stops.features.map((stop) => ({
    sequence: stop.properties.sequence,
    coordinates: stop.geometry.coordinates as [number, number],
  }))
  const segmentCoordinates = getJourneySegmentCoordinates(
    coordinates,
    stops,
    boardSequence,
    alightSequence,
  )
  const focusCoordinates: TripCoordinate[] = []
  if (segmentCoordinates && board && alight) {
    for (const [longitude, latitude] of segmentCoordinates) {
      focusCoordinates.push([latitude, longitude])
    }
  }
  if (board) focusCoordinates.push([board.geometry.coordinates[1], board.geometry.coordinates[0]])
  if (alight) focusCoordinates.push([alight.geometry.coordinates[1], alight.geometry.coordinates[0]])
  return {
    board,
    alight,
    segmentCoordinates: segmentCoordinates ?? undefined,
    focusCoordinates,
  }
}

export function previewDotStyleForZoom(zoom: number): { radius: number; weight: number } {
  if (zoom >= 16) return { radius: 5, weight: 1.4 }
  if (zoom >= 14) return { radius: 3.5, weight: 1.2 }
  if (zoom >= 12) return { radius: 2.4, weight: 1 }
  return { radius: 1.8, weight: 1 }
}
