import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { bindTextTooltip } from './leaflet-tooltip'
import type { DrawerView, DrawerViewSession } from './drawer-view'
import type {
  RouteMapVariant,
  RouteTimetable,
  TimetableStop,
  VehiclePosition,
} from './map-api-client'
import { createTimetablePanel } from './timetable-view'
import {
  normalizedVehicleAzimuth,
  routeStopMarkerMetrics,
  routeVariantPreviewStyle,
} from './route-detail-presentation'
import {
  routeCasingColor,
  routePalette,
  stopFillAccent,
  stopFillGreen,
  stopHaloColor,
} from './theme'

type BindHoverTooltip = <T extends L.Layer>(
  layer: T,
  content: string,
  options?: L.TooltipOptions,
) => T

type BindSelectableLine = (
  shape: RouteMapVariant['shape'],
  pane: string,
  layerGroup: L.LayerGroup,
  style: L.PathOptions,
) => { line: LeafletGeoJSON; target: LeafletGeoJSON }

type RouteDetailSurfaceOptions = {
  map: L.Map
  routeLayer: L.LayerGroup
  previewLayer: L.LayerGroup
  selectionLayer: L.LayerGroup
  vehicleLayer: L.LayerGroup
  renderDrawer: (view: DrawerView) => DrawerViewSession
  focusBounds: (bounds: L.LatLngBounds) => void
  focusPoint: (position: L.LatLngExpression, zoom: number) => void
  bindHoverTooltip: BindHoverTooltip
  bindSelectableLine: BindSelectableLine
  addPreviewStopDots: (stops: RouteMapVariant['stops'], color: string, layer: L.LayerGroup) => void
  drawerBack: (label: string, onClick: () => void) => HTMLButtonElement
  heading: (title: string, description: string) => HTMLElement
  paragraph: (text: string) => HTMLElement
  retryButton: (onClick: () => void) => HTMLButtonElement
}

type VariantPickerOptions = {
  cityCode: string
  routeName: string
  variants: RouteMapVariant[]
  backLabel: string
  onBack: () => void
  onSelect: (variant: RouteMapVariant) => void
}

type RouteViewOptions = {
  cityCode: string
  variant: RouteMapVariant
  color: string
  backLabel: string
  onBack: () => void
  onStopSelect: (latitude: number, longitude: number) => void
}

type TimetableViewOptions = {
  cityCode: string
  variant: RouteMapVariant
  timetable: RouteTimetable
  onBack: () => void
  onSelectStop: (stopUid: string) => void
}

export type RouteDetailSurface = {
  showVariantPicker(options: VariantPickerOptions): void
  showRoute(options: RouteViewOptions): HTMLButtonElement
  showTimetableLoading(cityCode: string, variant: RouteMapVariant, stopUid: string | undefined, onBack: () => void): void
  showTimetableError(cityCode: string, variant: RouteMapVariant, stopUid: string | undefined, message: string, onBack: () => void, onRetry: () => void): void
  showTimetable(options: TimetableViewOptions): { available: boolean }
  renderVehicles(vehicles: VehiclePosition[]): void
  clearRoute(): void
  clearSelection(): void
  clearVehicles(): void
  resizeStopMarkers(): void
}

export function createRouteDetailSurface(options: RouteDetailSurfaceOptions): RouteDetailSurface {
  let stopMarkers: L.CircleMarker[] = []

  function createStopMarker(
    position: L.LatLngExpression,
    prominent = false,
    fillColor = stopFillGreen,
  ): L.CircleMarker {
    const metrics = routeStopMarkerMetrics(options.map.getZoom(), prominent)
    return L.circleMarker(position, {
      pane: 'stopPane',
      radius: metrics.radius,
      color: stopHaloColor,
      weight: metrics.weight,
      fillColor,
      fillOpacity: .96,
    })
  }

  function clearRoute(): void {
    options.routeLayer.clearLayers()
    stopMarkers = []
  }

  function clearSelection(): void {
    options.selectionLayer.clearLayers()
  }

  function clearVehicles(): void {
    options.vehicleLayer.clearLayers()
  }

  function showVariantPicker(view: VariantPickerOptions): void {
    options.previewLayer.clearLayers()
    clearRoute()
    const bounds = L.latLngBounds([])
    const previewsByKey = new Map<string, { line: LeafletGeoJSON; style: L.PathOptions }>()

    view.variants.map((variant, index) => ({ variant, index })).reverse().forEach(({ variant, index }) => {
      const color = routePalette[index % routePalette.length]
      const style = routeVariantPreviewStyle(color, index)
      const { line, target } = options.bindSelectableLine(variant.shape, 'routePreviewPane', options.previewLayer, style)
      options.addPreviewStopDots(variant.stops, color, options.previewLayer)
      options.bindHoverTooltip(target, `${variant.label} · ${variant.subRouteName}`, { sticky: true })
      target.on('mouseover', () => {
        line.setStyle({ ...style, weight: 8, opacity: .9 })
        line.bringToFront()
      })
      target.on('mouseout', () => {
        line.setStyle(style)
        if (index !== 0) previewsByKey.get(view.variants[0].variantKey)?.line.bringToFront()
      })
      target.on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        view.onSelect(variant)
      })
      previewsByKey.set(variant.variantKey, { line, style })
      bounds.extend(line.getBounds())
    })

    const list = document.createElement('div')
    list.className = 'variant-list'
    list.replaceChildren(...view.variants.map((variant, index) => {
      const button = document.createElement('button')
      button.className = 'variant-button'
      button.style.setProperty('--route-color', routePalette[index % routePalette.length])
      const strong = document.createElement('strong')
      strong.textContent = variant.label
      button.appendChild(strong)
      if (variant.subRouteName && variant.subRouteName !== variant.routeName) {
        const small = document.createElement('span')
        small.textContent = variant.subRouteName
        button.appendChild(small)
      }
      button.addEventListener('click', () => view.onSelect(variant))
      button.addEventListener('mouseenter', () => {
        const preview = previewsByKey.get(variant.variantKey)
        preview?.line.setStyle({ ...preview.style, weight: 8, opacity: .9 })
        preview?.line.bringToFront()
      })
      button.addEventListener('mouseleave', () => {
        const preview = previewsByKey.get(variant.variantKey)
        preview?.line.setStyle(preview.style)
        if (variant.variantKey !== view.variants[0].variantKey) {
          previewsByKey.get(view.variants[0].variantKey)?.line.bringToFront()
        }
      })
      return button
    }))

    options.renderDrawer({
      key: `route-variants:${view.cityCode}:${view.routeName}`,
      mode: 'map-list',
      header: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, '同一路線可能穿過不同街廓，點線或點列表選一條。'),
      ],
      content: [list],
    })
    if (bounds.isValid()) options.focusBounds(bounds)
  }

  function showRoute(view: RouteViewOptions): HTMLButtonElement {
    clearRoute()
    clearSelection()
    const casing = L.geoJSON(view.variant.shape, {
      pane: 'routePane',
      style: { color: routeCasingColor, weight: 11, opacity: .95, lineCap: 'round', lineJoin: 'round' },
    }).addTo(options.routeLayer)
    L.geoJSON(view.variant.shape, {
      pane: 'routePane',
      style: { color: view.color, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' },
    }).addTo(options.routeLayer)
    L.geoJSON(view.variant.stops, {
      pointToLayer: (feature, latlng) => {
        const marker = options.bindHoverTooltip(
          createStopMarker(latlng),
          `${feature.properties.sequence}. ${feature.properties.stopName}`,
          { direction: 'top', offset: [0, -5] },
        ).on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          view.onStopSelect(latlng.lat, latlng.lng)
        })
        stopMarkers.push(marker)
        return marker
      },
    }).addTo(options.routeLayer)

    const timetableSummary = document.createElement('button')
    timetableSummary.type = 'button'
    timetableSummary.className = 'route-service-summary pending'
    timetableSummary.textContent = '正在讀取時刻…'
    timetableSummary.disabled = true
    options.renderDrawer({
      key: `route:${view.cityCode}:${view.variant.routeName}`,
      mode: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.variant.routeName, `${view.variant.label} · ${view.variant.stops.features.length} 站`),
        ...(view.variant.subRouteName && view.variant.subRouteName !== view.variant.routeName
          ? [options.paragraph(view.variant.subRouteName)]
          : []),
        timetableSummary,
      ],
    })
    const bounds = casing.getBounds()
    if (bounds.isValid()) options.focusBounds(bounds)
    return timetableSummary
  }

  function showTimetableLoading(
    cityCode: string,
    variant: RouteMapVariant,
    stopUid: string | undefined,
    onBack: () => void,
  ): void {
    options.renderDrawer({
      key: `timetable:${cityCode}:${variant.variantKey}:${stopUid ?? ""}`,
      mode: 'timetable',
      header: [
        options.drawerBack(`返回 ${variant.routeName}`, onBack),
        options.heading(variant.routeName, `時刻 · ${variant.label}`),
      ],
      content: [options.paragraph('正在整理表定班次…')],
    })
  }

  function showTimetableError(
    cityCode: string,
    variant: RouteMapVariant,
    stopUid: string | undefined,
    message: string,
    onBack: () => void,
    onRetry: () => void,
  ): void {
    options.renderDrawer({
      key: `timetable:${cityCode}:${variant.variantKey}:${stopUid ?? ""}`,
      mode: 'timetable',
      header: [
        options.drawerBack(`返回 ${variant.routeName}`, onBack),
        options.heading(variant.routeName, message),
      ],
      content: [options.retryButton(onRetry)],
    })
  }

  function focusTimetableStop(variant: RouteMapVariant, stop: Omit<TimetableStop, 'hasTimes'>): void {
    clearSelection()
    const feature = variant.stops.features.find((candidate) => candidate.properties.stopUid === stop.stopUid)
    if (!feature) return
    const [longitude, latitude] = feature.geometry.coordinates
    options.focusPoint([latitude, longitude], 15)
    const marker = createStopMarker([latitude, longitude], true, stopFillAccent).addTo(options.selectionLayer)
    marker.getElement()?.classList.add('timetable-stop-focus')
    marker.getElement()?.setAttribute('data-stop-uid', stop.stopUid)
  }

  function showTimetable(view: TimetableViewOptions): { available: boolean } {
    const available = view.timetable.mode !== 'none' && view.timetable.services.length > 0
    if (!available) {
      const panel = document.createElement('div')
      panel.className = 'timetable-panel'
      panel.appendChild(options.paragraph('這個方向目前沒有公開的表定班次資料。'))
      options.renderDrawer({
        key: `timetable:${view.cityCode}:${view.variant.variantKey}:${view.timetable.selectedStop?.stopUid ?? ""}`,
        mode: 'timetable',
        header: [
          options.drawerBack(`返回 ${view.variant.routeName}`, view.onBack),
          options.heading(view.variant.routeName, `時刻 · ${view.variant.label}`),
        ],
        content: [panel],
      })
      return { available: false }
    }

    const panel = createTimetablePanel(view.timetable, view.onSelectStop)
    options.renderDrawer({
      key: `timetable:${view.cityCode}:${view.variant.variantKey}:${view.timetable.selectedStop?.stopUid ?? ""}`,
      mode: 'timetable',
      header: [
        options.drawerBack(`返回 ${view.variant.routeName}`, view.onBack),
        options.heading(view.variant.routeName, `時刻 · ${view.variant.label}`),
      ],
      content: [panel],
    })
    if (view.timetable.mode === 'stop' && view.timetable.selectedStop) {
      queueMicrotask(() => focusTimetableStop(view.variant, view.timetable.selectedStop!))
    } else {
      clearSelection()
    }
    return { available: true }
  }

  function renderVehicles(vehicles: VehiclePosition[]): void {
    clearVehicles()
    vehicles.forEach((vehicle) => {
      const azimuth = normalizedVehicleAzimuth(vehicle.azimuth)
      const marker = L.marker([vehicle.latitude, vehicle.longitude], {
        pane: 'vehiclePane',
        icon: L.divIcon({
          className: 'vehicle-marker-wrap',
          html: `<span class="vehicle-marker" style="transform:rotate(${azimuth}deg)"></span>`,
          iconSize: [26, 32],
          iconAnchor: [13, 16],
        }),
      })
      options.bindHoverTooltip(
        marker,
        `${vehicle.plate ?? "公車"}${vehicle.speed === null ? "" : ` · ${Math.round(vehicle.speed)} km/h`}`,
      ).addTo(options.vehicleLayer)
    })
  }

  function resizeStopMarkers(): void {
    const metrics = routeStopMarkerMetrics(options.map.getZoom())
    stopMarkers.forEach((marker) => marker.setStyle(metrics))
  }

  return {
    showVariantPicker,
    showRoute,
    showTimetableLoading,
    showTimetableError,
    showTimetable,
    renderVehicles,
    clearRoute,
    clearSelection,
    clearVehicles,
    resizeStopMarkers,
  }
}
