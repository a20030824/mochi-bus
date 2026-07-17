import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { buildNetworkIndex, pickNetwork, type LonLat, type NetworkIndex } from '../../src/domain/map/network-pick'
import { setTextTooltip } from './leaflet-tooltip'
import type { CityNetwork } from './map-api-client'
import { networkStopRadius } from './network-style'

export type ResolvedNetworkPick =
  | { kind: 'place'; place: CityNetwork['places'][number] }
  | { kind: 'route'; route: CityNetwork['routes'][number]; routeIndex: number }

type NetworkCity = { code: string }
type RequestTicket = { requestId: number; signal: AbortSignal }

type CityNetworkControllerOptions = {
  map: L.Map
  layer: L.LayerGroup
  renderer: L.Renderer
  button: HTMLButtonElement
  hoverCapable: boolean
  routeColor: (routeName: string) => string
  beginRequest: () => RequestTicket
  isStaleRequest: (requestId: number) => boolean
  loadNetwork: (city: string, signal?: AbortSignal) => Promise<CityNetwork>
  setStatus: (text: string, error?: boolean) => void
}

export function createCityNetworkController(options: CityNetworkControllerOptions) {
  let visible = false
  let cache: { city: string; data: CityNetwork; index: NetworkIndex } | undefined
  let stopMarkers: L.CircleMarker[] = []
  let hoverLine: LeafletGeoJSON | undefined
  let hoverRouteIndex = -1
  let hoverFrame: number | undefined
  let hoverLatLng: L.LatLng | undefined
  const hoverTooltip = L.tooltip({ direction: 'top', offset: [0, -10] })

  options.map.on('mousemove', (event) => {
    if (!options.hoverCapable || !visible) return
    hoverLatLng = event.latlng
    if (hoverFrame !== undefined) return
    hoverFrame = requestAnimationFrame(() => {
      hoverFrame = undefined
      if (hoverLatLng) updateHover(hoverLatLng)
    })
  })
  options.map.on('movestart', clearHover)
  options.map.on('mouseout', clearHover)

  async function toggle(city: NetworkCity): Promise<void> {
    if (visible) {
      hide()
      return
    }
    const { requestId, signal } = options.beginRequest()
    options.setStatus('正在展開整個城市路網…')
    try {
      let entry = cache
      if (!cache || cache.city !== city.code) {
        const data = await options.loadNetwork(city.code, signal)
        if (options.isStaleRequest(requestId)) return
        entry = {
          city: city.code,
          data,
          index: buildNetworkIndex(
            data.routes.map((route) => route.shape.geometry.coordinates as LonLat[]),
            data.places.map((place) => [place.longitude, place.latitude] as LonLat),
          ),
        }
        cache = entry
      }
      if (options.isStaleRequest(requestId) || !entry) return
      draw(entry.data)
      options.setStatus(`全路網 · ${entry.data.routes.length} 個方向 · ${entry.data.places.length} 個站點`)
    } catch (error) {
      if (options.isStaleRequest(requestId)) return
      options.setStatus(error instanceof Error && error.message ? error.message : '全路網讀取失敗', true)
    }
  }

  function draw(network: CityNetwork): void {
    options.layer.clearLayers()
    clearHover()
    stopMarkers = []

    const lineStyle = {
      weight: 2.6,
      opacity: .34,
      lineCap: 'round' as const,
      lineJoin: 'round' as const,
    }
    network.routes.forEach((route) => {
      L.geoJSON(route.shape, {
        style: {
          renderer: options.renderer,
          color: options.routeColor(route.routeName),
          interactive: false,
          ...lineStyle,
        },
      }).addTo(options.layer)
    })
    const radius = networkStopRadius(options.map.getZoom())
    network.places.forEach((place) => {
      stopMarkers.push(L.circleMarker([place.latitude, place.longitude], {
        renderer: options.renderer,
        interactive: false,
        radius,
        weight: 1,
        color: '#fffaf0',
        fillColor: '#4f685b',
        fillOpacity: .72,
      }).addTo(options.layer))
    })
    visible = true
    options.button.classList.add('active')
    options.button.setAttribute('aria-pressed', 'true')
  }

  function hide(): void {
    clearHover()
    options.layer.clearLayers()
    stopMarkers = []
    visible = false
    options.button.classList.remove('active')
    options.button.setAttribute('aria-pressed', 'false')
  }

  function pickAt(latlng: L.LatLng, routePixels: number, placePixels: number): ResolvedNetworkPick | undefined {
    if (!visible || !cache) return undefined
    const pick = pickNetwork(
      cache.index,
      [latlng.lng, latlng.lat],
      pixelsToLatDegrees(routePixels),
      pixelsToLatDegrees(placePixels),
    )
    if (!pick) return undefined
    if (pick.kind === 'place') return { kind: 'place', place: cache.data.places[pick.placeIndex] }
    return { kind: 'route', route: cache.data.routes[pick.routeIndex], routeIndex: pick.routeIndex }
  }

  function pixelsToLatDegrees(pixels: number): number {
    const size = options.map.getSize()
    const center = options.map.containerPointToLatLng([size.x / 2, size.y / 2])
    const shifted = options.map.containerPointToLatLng([size.x / 2, size.y / 2 - pixels])
    return Math.abs(shifted.lat - center.lat)
  }

  function updateHover(latlng: L.LatLng): void {
    const pick = pickAt(latlng, 6, 9)
    if (!pick) {
      clearHover()
      return
    }
    options.map.getContainer().style.cursor = 'pointer'
    if (pick.kind === 'place') {
      setHighlight(-1)
      setTextTooltip(hoverTooltip, pick.place.name).setLatLng([pick.place.latitude, pick.place.longitude])
    } else {
      setHighlight(pick.routeIndex)
      setTextTooltip(hoverTooltip, `${pick.route.routeName} · ${pick.route.label}`).setLatLng(latlng)
    }
    if (!options.map.hasLayer(hoverTooltip)) hoverTooltip.openOn(options.map)
  }

  function setHighlight(routeIndex: number): void {
    if (routeIndex === hoverRouteIndex) return
    hoverLine?.remove()
    hoverLine = undefined
    hoverRouteIndex = routeIndex
    if (routeIndex < 0 || !cache) return
    const route = cache.data.routes[routeIndex]
    hoverLine = L.geoJSON(route.shape, {
      pane: 'networkHoverPane',
      style: {
        color: options.routeColor(route.routeName),
        weight: 5,
        opacity: .75,
        lineCap: 'round',
        lineJoin: 'round',
        interactive: false,
      },
    }).addTo(options.map)
  }

  function clearHover(): void {
    setHighlight(-1)
    hoverLatLng = undefined
    if (options.map.hasLayer(hoverTooltip)) options.map.closeTooltip(hoverTooltip)
    options.map.getContainer().style.cursor = ''
  }

  function resizeStopMarkers(): void {
    const radius = networkStopRadius(options.map.getZoom())
    stopMarkers.forEach((marker) => marker.setRadius(radius))
  }

  return { toggle, hide, pickAt, resizeStopMarkers }
}
