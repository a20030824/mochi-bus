import L from 'leaflet'
import { getJourneySegmentCoordinates } from '../../src/domain/map/journey-segment'
import { bindTextTooltip } from './leaflet-tooltip'
import { stopHaloColor } from './theme'
import {
  createPreviewStopDotManager,
  createSelectablePreviewLineRenderer,
} from './preview-map-primitives'
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
  const selectablePreviewLine = createSelectablePreviewLineRenderer({ hoverCapable: options.hoverCapable })
  const stopDots = createPreviewStopDotManager({ map: options.map, pane: dotPane })

  function bindHoverTooltip<T extends L.Layer>(layer: T, content: string, tooltipOptions?: L.TooltipOptions): T {
    if (options.hoverCapable) bindTextTooltip(layer, content, tooltipOptions)
    return layer
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
    const { target: fullLineTarget } = selectablePreviewLine(variant.shape, routePane, options.layer, {
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
      stopDots.add(variant.stops, color, options.layer)
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
    resizeStopMarkers: stopDots.resize,
    reset: stopDots.reset,
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
