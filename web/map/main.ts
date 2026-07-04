import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { matchStopsToShape } from '../../src/domain/map/shape-matcher'
import 'leaflet/dist/leaflet.css'
import './style.css'

type MapCity = {
  code: string
  name: string
  region: RegionCode
  center: [number, number]
}

type RouteItem = {
  routeName: string
  category: string
}

type RouteMapVariant = {
  variantKey: string
  routeName: string
  routeUid: string
  direction: 0 | 1
  label: string
  subRouteName: string
  shape: GeoJSON.Feature<GeoJSON.LineString>
  stops: GeoJSON.FeatureCollection<GeoJSON.Point, {
    stopUid: string
    stopName: string
    sequence: number
  }>
  updatedAt: string | null
}

type NearbyPlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters: number
}

type PlaceRoute = {
  routeUid: string
  routeName: string
  variantKey: string
  direction: 0 | 1
  label: string
  subRouteName: string
  stopUid: string
  stopName: string
  stopSequence: number
  estimateSeconds: number | null
  etaLabel: string
  stopStatus: number
}

type DirectRoute = PlaceRoute & {
  boardSequence: number
  alightSequence: number
  stopCount: number
  etaMinutes?: number | null
}

type TransferLeg = {
  routeName: string
  variantKey: string
  label: string
  boardSequence: number
  alightSequence: number
  stopCount: number
}

type TransferPlan = {
  transferPlaceId: string
  secondTransferPlaceId?: string
  transferName: string
  transferWalkMeters?: number
  totalStops: number
  first: TransferLeg
  second: TransferLeg
  firstEtaMinutes?: number | null
  secondEtaMinutes?: number | null
  transferWaitMinutes?: number | null
  estimatedTotalMinutes?: number | null
  connectionStatus?: 'comfortable' | 'tight' | 'unknown'
}

type CityNetwork = {
  version: string
  routes: Array<{
    routeName: string
    variantKey: string
    label: string
    shape: GeoJSON.Feature<GeoJSON.LineString>
  }>
  places: Array<Omit<NearbyPlace, 'distanceMeters'>>
}

type VehiclePosition = {
  plate: string | null
  latitude: number
  longitude: number
  speed: number | null
  azimuth: number | null
  gpsTime: string | null
}

type RegionCode = 'north' | 'central' | 'south' | 'east' | 'islands'

const regions: Array<{
  code: RegionCode
  name: string
  center: [number, number]
  zoom: number
}> = [
  { code: 'north', name: '北部', center: [24.98, 121.25], zoom: 8 },
  { code: 'central', name: '中部', center: [23.95, 120.72], zoom: 8 },
  { code: 'south', name: '南部', center: [22.95, 120.35], zoom: 8 },
  { code: 'east', name: '東部', center: [23.65, 121.35], zoom: 8 },
  { code: 'islands', name: '離島', center: [24.1, 119.25], zoom: 7 },
]

const mapNode = requiredElement('map')
const ACTIVE_CITY_KEY = 'mochi.bus.activeCity.v1'
const BOARDS_KEY = 'mochi.bus.boards.v2'
const ACTIVE_BOARD_KEY = 'mochi.bus.activeBoard.v2'
const drawer = requiredElement('map-drawer')
const statusNode = requiredElement('map-status')
const networkButton = document.createElement('button')
networkButton.className = 'network-toggle'
networkButton.type = 'button'
networkButton.textContent = '▦'
networkButton.title = '顯示全路網與全部站點'
networkButton.setAttribute('aria-label', '切換全路網與全部站點')
networkButton.hidden = true
document.getElementById('map-app')?.appendChild(networkButton)

const map = L.map(mapNode, {
  zoomControl: false,
  preferCanvas: true,
  minZoom: 6,
  maxZoom: 19,
}).setView([23.75, 120.9], 7)

map.createPane('routePreviewPane').style.zIndex = '420'
map.createPane('routePane').style.zIndex = '440'
map.createPane('stopPane').style.zIndex = '480'
map.createPane('networkPane').style.zIndex = '410'
map.createPane('vehiclePane').style.zIndex = '520'

L.control.zoom({ position: 'bottomleft' }).addTo(map)
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
}).addTo(map)

const selectionLayer = L.layerGroup().addTo(map)
const routeLayer = L.layerGroup().addTo(map)
const previewLayer = L.layerGroup().addTo(map)
const nearbyLayer = L.layerGroup().addTo(map)
const networkLayer = L.layerGroup().addTo(map)
const vehicleLayer = L.layerGroup().addTo(map)
let cities: MapCity[] = []
let activeCity: MapCity | undefined
let routes: RouteItem[] = []
let category = '全部'
let stopMarkers: L.CircleMarker[] = []
let lastNearbyPlaces: NearbyPlace[] = []
let lastNearbyOrigin: [number, number] | undefined
let selectedFrom: NearbyPlace | undefined
let selectedTo: NearbyPlace | undefined
let fromCoordinate: [number, number] | undefined
let toCoordinate: [number, number] | undefined
let tripStage: 'idle' | 'from' | 'to' = 'idle'
let lastDirectRoutes: DirectRoute[] = []
let lastTransferPlans: TransferPlan[] = []
let interactionMode: 'browse' | 'nearby' | 'trip' | 'trip-results' | 'route' = 'browse'
let routeReturnsToTrip = false
let activeRouteColor = '#b85f49'
let previewRequest = 0
let selectedTransferIndex = 0
let routeBackAction: (() => void) | undefined
let routeBackLabel = '更換路線'
let networkVisible = false
let networkCache: { city: string; data: CityNetwork } | undefined
let networkStopMarkers: L.CircleMarker[] = []
let vehicleRefreshTimer: number | undefined

const routePalette = ['#b85f49', '#4f685b', '#55718a', '#b08a47', '#765b78', '#6f7561']

void initialise()

async function initialise() {
  try {
    const response = await fetch('/api/v1/map/cities')
    const data = await response.json() as { cities: MapCity[] }
    cities = data.cities
    const params = new URLSearchParams(location.search)
    const cityCode = params.get('city') || localStorage.getItem(ACTIVE_CITY_KEY)
    const routeName = params.get('route')
    if (cityCode) {
      const city = cities.find((candidate) => candidate.code === cityCode)
      if (city) {
        activeCity = city
        map.setView(city.center, 11)
        if (routeName) {
          await loadRoute(routeName, params.get('variant'))
        } else {
          await chooseCity(city)
          const placeId = params.get('place')
          if (placeId) {
            await openPlaceById(placeId)
            return
          }
          const latitudeParam = params.get('lat')
          const longitudeParam = params.get('lon')
          const latitude = Number(latitudeParam)
          const longitude = Number(longitudeParam)
          if (latitudeParam !== null && longitudeParam !== null && Number.isFinite(latitude) && Number.isFinite(longitude)) {
            map.setView([latitude, longitude], 15)
            await findNearbyPlaces(latitude, longitude)
          }
        }
        return
      }
    }
    showTaiwan()
  } catch {
    setStatus('地圖初始化失敗，請稍後再試。', true)
  }
}

networkButton.addEventListener('click', () => void toggleCityNetwork())
map.on('zoomend', updateStopMarkerSize)
map.on('click', (event) => {
  if (!activeCity) return
  if (tripStage !== 'idle') void selectTripCoordinate(event.latlng.lat, event.latlng.lng)
  else if (map.getZoom() >= 14) void findNearbyPlaces(event.latlng.lat, event.latlng.lng, true)
  else {
    map.flyTo(event.latlng, 14)
    setStatus('放大後再選站牌，避免誤選太遠的位置')
  }
})

function showTaiwan() {
  stopVehicleRefresh()
  activeCity = undefined
  networkButton.hidden = true
  setNetworkVisible(false)
  routeLayer.clearLayers()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  selectedFrom = undefined
  selectedTo = undefined
  fromCoordinate = undefined
  toCoordinate = undefined
  tripStage = 'idle'
  lastDirectRoutes = []
  lastTransferPlans = []
  map.setView([23.75, 120.9], 7)
  setStatus('選一個區域，看看公車如何穿過城市。')
  renderRegionMarkers()
  drawer.replaceChildren(
    heading('先從哪裡開始？', '公車不是清單，是城市的骨架。'),
    buttonGrid(regions.map((region) => ({
      label: region.name,
      onClick: () => showRegion(region.code),
    }))),
  )
  history.replaceState(null, '', '/map')
}

function renderRegionMarkers() {
  for (const region of regions.filter((item) => item.code !== 'islands')) {
    L.marker(region.center, {
      icon: L.divIcon({
        className: 'region-marker-wrap',
        html: `<span class="region-marker">${region.name}</span>`,
        iconSize: [74, 40],
        iconAnchor: [37, 20],
      }),
      title: region.name,
    }).on('click', () => showRegion(region.code)).addTo(selectionLayer)
  }
}

function showRegion(regionCode: RegionCode) {
  stopVehicleRefresh()
  networkButton.hidden = true
  setNetworkVisible(false)
  const region = regions.find((candidate) => candidate.code === regionCode)!
  routeLayer.clearLayers()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  map.setView(region.center, region.zoom)
  setStatus(`${region.name} · 選擇縣市`)
  const regionCities = cities.filter((city) => city.region === regionCode)
  for (const city of regionCities) {
    L.marker(city.center, {
      icon: L.divIcon({
        className: 'city-marker-wrap',
        html: `<span class="city-marker">${city.name}</span>`,
        iconSize: [68, 34],
        iconAnchor: [34, 17],
      }),
      title: city.name,
    }).on('click', () => void chooseCity(city)).addTo(selectionLayer)
  }
  drawer.replaceChildren(
    drawerBack('返回區域', showTaiwan),
    heading(region.name, '直接點地圖上的縣市，或從這裡選。'),
    buttonGrid(regionCities.map((city) => ({
      label: city.name,
      onClick: () => void chooseCity(city),
    }))),
  )
}

async function chooseCity(city: MapCity) {
  stopVehicleRefresh()
  activeCity = city
  localStorage.setItem(ACTIVE_CITY_KEY, city.code)
  networkButton.hidden = false
  setNetworkVisible(false)
  selectionLayer.clearLayers()
  routeLayer.clearLayers()
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  selectedFrom = undefined
  selectedTo = undefined
  fromCoordinate = undefined
  toCoordinate = undefined
  tripStage = 'idle'
  lastDirectRoutes = []
  lastTransferPlans = []
  map.setView(city.center, 11)
  setStatus(`${city.name} · 正在整理路線…`)
  drawer.replaceChildren(drawerBack('返回區域', () => showRegion(city.region)), heading(city.name, '正在載入路線…'))

  try {
    const response = await fetch(`/api/v1/map/routes?city=${encodeURIComponent(city.code)}`)
    const data = await response.json() as { routes?: RouteItem[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    routes = data.routes
    category = '全部'
    renderRoutePicker()
    setStatus(`${city.name} · ${routes.length} 條路線`)
  } catch {
    setStatus('目前無法載入這個縣市的路線。', true)
  }
}

function renderRoutePicker() {
  if (!activeCity) return
  stopVehicleRefresh()
  interactionMode = 'browse'
  routeReturnsToTrip = false
  routeBackAction = undefined
  clearTripState()
  routeLayer.clearLayers()
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  stopMarkers = []
  const back = drawerBack('返回縣市', () => showRegion(activeCity!.region))
  const title = heading(activeCity.name, '不用設定起終點，直接看一條公車。')
  const search = document.createElement('input')
  search.className = 'map-search'
  search.placeholder = '快速篩選路線'
  search.setAttribute('aria-label', '快速篩選路線')
  const categories = document.createElement('div')
  categories.className = 'map-categories'
  const routeGrid = document.createElement('div')
  routeGrid.className = 'map-route-grid'

  const counts = new Map<string, number>()
  routes.forEach((route) => counts.set(route.category, (counts.get(route.category) ?? 0) + 1))
  const names = ['全部', ...['數字', '幹線', '接駁', '幸福／社區', '觀光', '小黃', '其他'].filter((name) => counts.has(name))]

  const render = () => {
    categories.replaceChildren(...names.map((name) => {
      const button = document.createElement('button')
      button.className = `map-chip${category === name ? ' active' : ''}`
      button.textContent = name
      button.addEventListener('click', () => {
        category = name
        render()
      })
      return button
    }))
    const query = search.value.trim().toLowerCase()
    const visible = routes
      .filter((route) => category === '全部' || route.category === category)
      .filter((route) => !query || route.routeName.toLowerCase().includes(query))
      .slice(0, 100)
    routeGrid.replaceChildren(...visible.map((route) => {
      const button = document.createElement('button')
      button.className = 'map-route-button'
      button.textContent = route.routeName
      button.addEventListener('click', () => void loadRoute(route.routeName))
      return button
    }))
  }
  search.addEventListener('input', render)
  drawer.replaceChildren(back, title, tripModeButton(), search, categories, routeGrid)
  render()
}

function tripModeButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'trip-mode-button'
  button.textContent = '↗'
  button.title = '直達導航'
  button.setAttribute('aria-label', '直達導航：選擇出發位置與目的地')
  button.addEventListener('click', () => {
    selectedFrom = undefined
    selectedTo = undefined
    fromCoordinate = undefined
    toCoordinate = undefined
    lastDirectRoutes = []
    lastTransferPlans = []
    lastTransferPlans = []
    tripStage = 'from'
    interactionMode = 'trip'
    setNetworkVisible(false)
    previewLayer.clearLayers()
    routeLayer.clearLayers()
    nearbyLayer.clearLayers()
    drawer.replaceChildren(
      drawerBack('取消直達查詢', cancelTripMode),
      heading('點一下出發位置', '直接點地圖，系統會配對最近站牌。'),
    )
    setStatus('直達導航 · 請點出發位置')
  })
  return button
}

function cancelTripMode() {
  clearTripState()
  interactionMode = 'browse'
  routeBackAction = undefined
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  renderRoutePicker()
}

function clearTripState() {
  tripStage = 'idle'
  selectedFrom = undefined
  selectedTo = undefined
  fromCoordinate = undefined
  toCoordinate = undefined
  lastDirectRoutes = []
  lastTransferPlans = []
}

function unifiedStopMarker(
  position: L.LatLngExpression,
  prominent = false,
  fillColor = '#4f685b',
): L.CircleMarker {
  const prominentRadius = map.getZoom() >= 16 ? 11 : 9
  return L.circleMarker(position, {
    pane: 'stopPane',
    radius: prominent ? prominentRadius : stopStyleForZoom(map.getZoom()).radius,
    color: '#fffaf0',
    weight: prominent ? 2.4 : 1.4,
    fillColor,
    fillOpacity: .96,
  })
}

function drawTripEndpoints() {
  if (fromCoordinate) {
    unifiedStopMarker(fromCoordinate, true, '#b85f49').bindTooltip('出發位置', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
  if (toCoordinate) {
    unifiedStopMarker(toCoordinate, true, '#55718a').bindTooltip('目的地', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
}

async function loadRoute(
  routeName: string,
  preferredVariant?: string | null,
  returnToTrip = false,
  color = '#b85f49',
  backAction?: () => void,
) {
  if (!activeCity) return
  setNetworkVisible(false)
  routeReturnsToTrip = returnToTrip
  activeRouteColor = color
  routeBackAction = backAction
  routeBackLabel = backAction ? '返回站點' : '更換路線'
  previewRequest += 1
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  if (!returnToTrip) clearTripState()
  setStatus(`${routeName} · 正在讀取城市裡的路徑…`)
  drawer.replaceChildren(drawerBack('返回路線', renderRoutePicker), heading(routeName, '正在拼起路線與站牌…'))
  try {
    const params = new URLSearchParams({ city: activeCity.code, route: routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    const data = await response.json() as { variants?: RouteMapVariant[]; error?: string }
    if (!response.ok || !data.variants?.length) throw new Error(data.error)
    const preferred = data.variants.find((variant) => variant.variantKey === preferredVariant)
    if (preferred) {
      drawVariant(preferred)
    } else if (data.variants.length === 1) {
      drawVariant(data.variants[0])
    } else {
      renderVariantPicker(routeName, data.variants)
      setStatus(`${routeName} · 選擇行駛方向`)
    }
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '目前無法取得這條路線。', true)
  }
}

function renderVariantPicker(routeName: string, variants: RouteMapVariant[]) {
  const list = document.createElement('div')
  list.className = 'variant-list'
  list.replaceChildren(...variants.map((variant) => {
    const button = document.createElement('button')
    button.className = 'variant-button'
    const strong = document.createElement('strong')
    strong.textContent = variant.label
    const small = document.createElement('span')
    small.textContent = variant.subRouteName
    button.appendChild(strong)
    button.appendChild(small)
    button.addEventListener('click', () => drawVariant(variant))
    return button
  }))
  drawer.replaceChildren(
    drawerBack(routeBackAction ? '返回站點' : '返回路線', routeBackAction ?? renderRoutePicker),
    heading(routeName, '同一路線可能穿過不同街廓。'),
    list,
  )
}

function drawVariant(variant: RouteMapVariant) {
  interactionMode = 'route'
  if (!routeReturnsToTrip) clearTripState()
  routeLayer.clearLayers()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  stopMarkers = []
  const casing = L.geoJSON(variant.shape, {
    pane: 'routePane',
    style: { color: '#f4efe4', weight: 11, opacity: 0.95, lineCap: 'round', lineJoin: 'round' },
  }).addTo(routeLayer)
  L.geoJSON(variant.shape, {
    pane: 'routePane',
    style: { color: activeRouteColor, weight: 5, opacity: 1, lineCap: 'round', lineJoin: 'round' },
  }).addTo(routeLayer)
  L.geoJSON(variant.stops, {
    pointToLayer: (feature, latlng) => {
      const marker = unifiedStopMarker(latlng)
        .bindTooltip(`${feature.properties.sequence}. ${feature.properties.stopName}`, {
          direction: 'top',
          offset: [0, -5],
        })
        .on('click', (event) => {
          L.DomEvent.stopPropagation(event)
          void findNearbyPlaces(latlng.lat, latlng.lng, true)
        })
      stopMarkers.push(marker)
      return marker
    },
  }).addTo(routeLayer)

  const bounds = casing.getBounds()
  if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [40, 90], paddingBottomRight: [40, 260] })
  setStatus(`${variant.routeName} · ${variant.stops.features.length} 站`)
  const change = document.createElement('button')
  change.className = 'quiet-button'
  change.textContent = routeReturnsToTrip ? '返回行程候選' : routeBackLabel
  change.addEventListener('click', () => {
    if (routeReturnsToTrip && (lastDirectRoutes.length || lastTransferPlans.length)) {
      interactionMode = 'trip-results'
      if (lastDirectRoutes.length) {
        renderDirectRoutes(lastDirectRoutes)
        void previewDirectRoutes(lastDirectRoutes)
      } else {
        renderTransferPlans(lastTransferPlans)
        void previewTransferPlans(lastTransferPlans)
      }
      nearbyLayer.clearLayers()
      drawTripEndpoints()
    } else if (routeBackAction) routeBackAction()
    else renderRoutePicker()
  })
  drawer.replaceChildren(
    heading(variant.routeName, variant.label),
    paragraph(variant.subRouteName),
    change,
  )
  const params = new URLSearchParams({
    city: activeCity!.code,
    route: variant.routeName,
    routeUid: variant.routeUid,
    direction: String(variant.direction),
    variant: variant.variantKey,
  })
  history.replaceState(null, '', `/map?${params}`)
  startVehicleRefresh(variant)
}

function stopStyleForZoom(zoom: number): L.CircleMarkerOptions {
  if (zoom >= 16) return { radius: 8, weight: 1.8 }
  if (zoom >= 13) return { radius: 5, weight: 1.4 }
  return { radius: 2, weight: 1 }
}

function updateStopMarkerSize() {
  const style = stopStyleForZoom(map.getZoom())
  stopMarkers.forEach((marker) => marker.setStyle(style))
  const radius = map.getZoom() >= 15 ? 4 : map.getZoom() >= 12 ? 2.5 : 1.4
  networkStopMarkers.forEach((marker) => marker.setRadius(radius))
}

function startVehicleRefresh(variant: RouteMapVariant) {
  stopVehicleRefresh()
  const refresh = async () => {
    if (!activeCity || interactionMode !== 'route') return
    const params = new URLSearchParams({
      city: activeCity.code,
      route: variant.routeName,
      routeUid: variant.routeUid,
      direction: String(variant.direction),
    })
    try {
      const response = await fetch(`/api/v1/map/vehicles?${params}`, { cache: 'no-store' })
      const data = await response.json() as { vehicles?: VehiclePosition[] }
      if (!response.ok || !data.vehicles) return
      vehicleLayer.clearLayers()
      data.vehicles.forEach((vehicle) => {
        const azimuth = Number.isFinite(vehicle.azimuth) ? vehicle.azimuth as number : 0
        const marker = L.marker([vehicle.latitude, vehicle.longitude], {
          pane: 'vehiclePane',
          icon: L.divIcon({
            className: 'vehicle-marker-wrap',
            html: `<span class="vehicle-marker" style="transform:rotate(${azimuth}deg)"></span>`,
            iconSize: [26, 32],
            iconAnchor: [13, 16],
          }),
        })
        const tooltip = document.createElement('span')
        tooltip.textContent = `${vehicle.plate ?? '公車'}${vehicle.speed === null ? '' : ` · ${Math.round(vehicle.speed)} km/h`}`
        marker.bindTooltip(tooltip).addTo(vehicleLayer)
      })
    } catch {
      // 車輛定位是輔助資訊，失敗時保留主路線而不打斷操作。
    }
  }
  void refresh()
  vehicleRefreshTimer = window.setInterval(() => void refresh(), 20_000)
}

function stopVehicleRefresh() {
  if (vehicleRefreshTimer !== undefined) window.clearInterval(vehicleRefreshTimer)
  vehicleRefreshTimer = undefined
  vehicleLayer.clearLayers()
}

async function toggleCityNetwork() {
  if (!activeCity) return
  if (networkVisible) {
    setNetworkVisible(false)
    return
  }
  setStatus('正在展開整個城市路網…')
  try {
    if (!networkCache || networkCache.city !== activeCity.code) {
      const response = await fetch(`/api/v1/map/network?city=${encodeURIComponent(activeCity.code)}`)
      const data = await response.json() as CityNetwork & { error?: string }
      if (!response.ok) throw new Error(data.error)
      networkCache = { city: activeCity.code, data }
    }
    drawCityNetwork(networkCache.data)
    setStatus(`全路網 · ${networkCache.data.routes.length} 個方向 · ${networkCache.data.places.length} 個站點`)
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '全路網讀取失敗', true)
  }
}

function drawCityNetwork(network: CityNetwork) {
  stopVehicleRefresh()
  routeLayer.clearLayers()
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  networkLayer.clearLayers()
  networkStopMarkers = []
  network.routes.forEach((route, index) => {
    const color = routePalette[index % routePalette.length]
    const line = L.geoJSON(route.shape, {
      pane: 'networkPane',
      style: { color, weight: 2.6, opacity: .34, lineCap: 'round', lineJoin: 'round' },
    }).bindTooltip(`${route.routeName} · ${route.label}`, { sticky: true })
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void loadRoute(route.routeName, route.variantKey, false, color)
      })
      .addTo(networkLayer)
    line.on('mouseover', () => line.setStyle({ weight: 5, opacity: .75 }))
    line.on('mouseout', () => line.setStyle({ weight: 2.6, opacity: .34 }))
  })
  const radius = map.getZoom() >= 15 ? 4 : map.getZoom() >= 12 ? 2.5 : 1.4
  network.places.forEach((place) => {
    const marker = L.circleMarker([place.latitude, place.longitude], {
      pane: 'stopPane', radius, weight: 1, color: '#fffaf0', fillColor: '#4f685b', fillOpacity: .72,
    }).bindTooltip(place.name)
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void findNearbyPlaces(place.latitude, place.longitude, true)
      })
      .addTo(networkLayer)
    networkStopMarkers.push(marker)
  })
  networkVisible = true
  networkButton.classList.add('active')
  networkButton.setAttribute('aria-pressed', 'true')
}

function setNetworkVisible(visible: boolean) {
  if (visible) return
  networkLayer.clearLayers()
  networkStopMarkers = []
  networkVisible = false
  networkButton.classList.remove('active')
  networkButton.setAttribute('aria-pressed', 'false')
}

async function findNearbyPlaces(latitude: number, longitude: number, autoPreview = false) {
  if (!activeCity) return
  stopVehicleRefresh()
  setNetworkVisible(false)
  if (interactionMode === 'trip' || interactionMode === 'trip-results' || routeReturnsToTrip) clearTripState()
  interactionMode = 'nearby'
  routeReturnsToTrip = false
  previewRequest += 1
  previewLayer.clearLayers()
  routeLayer.clearLayers()
  stopMarkers = []
  const loadingList = document.createElement('div')
  loadingList.className = 'place-route-loading'
  for (let index = 0; index < 3; index += 1) {
    const skeleton = document.createElement('div')
    skeleton.className = 'place-route-skeleton'
    loadingList.appendChild(skeleton)
  }
  drawer.replaceChildren(
    drawerBack('附近站牌', renderNearbyPlaces),
    heading('附近站牌', '正在搜尋附近站牌'),
    loadingList,
  )
  nearbyLayer.clearLayers()
  lastNearbyOrigin = [latitude, longitude]
  const city = activeCity
  const radius = map.getZoom() >= 15 ? 300 : 500
  unifiedStopMarker([latitude, longitude], true, '#b85f49').addTo(nearbyLayer)
  setStatus('正在找這附近的站牌…')

  try {
    const params = new URLSearchParams({
      city: city.code,
      lat: String(latitude),
      lon: String(longitude),
      radius: String(radius),
    })
    const response = await fetch(`/api/v1/map/nearby?${params}`)
    const data = await response.json() as { places?: NearbyPlace[]; error?: string }
    if (!response.ok || !data.places) throw new Error(data.error)
    lastNearbyPlaces = data.places.slice(0, 12)
    renderNearbyPlaces()
    if (autoPreview && lastNearbyPlaces[0]) await showPlaceRoutes(lastNearbyPlaces[0])
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '附近站牌讀取失敗', true)
  }
}

function renderNearbyPlaces() {
  if (!activeCity || !lastNearbyOrigin) return
  nearbyLayer.clearLayers()
  const origin = unifiedStopMarker(lastNearbyOrigin, true, '#b85f49').addTo(nearbyLayer)
  origin.bindTooltip('你點的位置')

  for (const place of lastNearbyPlaces) {
    unifiedStopMarker([place.latitude, place.longitude], true)
      .bindTooltip(`${place.name} · ${Math.round(place.distanceMeters)} m`)
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void showPlaceRoutes(place)
      })
      .addTo(nearbyLayer)
  }
  drawTripEndpoints()

  const list = document.createElement('div')
  list.className = 'nearby-list'
  if (!lastNearbyPlaces.length) list.appendChild(paragraph('500 公尺內沒有收錄到站牌，換個位置試試。'))
  for (const place of lastNearbyPlaces) {
    const button = document.createElement('button')
    button.className = 'nearby-place-button'
    const name = document.createElement('strong')
    name.textContent = place.name
    const distance = document.createElement('span')
    distance.textContent = `${Math.round(place.distanceMeters)} m`
    button.appendChild(name)
    button.appendChild(distance)
    button.addEventListener('click', () => void showPlaceRoutes(place))
    list.appendChild(button)
  }
  drawer.replaceChildren(
    drawerBack('路線列表', renderRoutePicker),
    heading('附近站牌', '點任一站牌，就會預覽所有經過路線。'),
    list,
    tripModeButton(),
  )
  setStatus(lastNearbyPlaces.length ? `找到 ${lastNearbyPlaces.length} 個附近站牌` : '附近沒有站牌')
  const [latitude, longitude] = lastNearbyOrigin
  history.replaceState(null, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
}

async function selectTripCoordinate(latitude: number, longitude: number) {
  if (!activeCity) return
  const radius = map.getZoom() >= 15 ? 300 : 500
  const params = new URLSearchParams({ city: activeCity.code, lat: String(latitude), lon: String(longitude), radius: String(radius) })
  setStatus(tripStage === 'from' ? '正在配對出發位置附近站牌…' : '正在配對目的地附近站牌…')
  try {
    const response = await fetch(`/api/v1/map/nearby?${params}`)
    const data = await response.json() as { places?: NearbyPlace[]; error?: string }
    const nearest = data.places?.[0]
    if (!response.ok || !nearest) throw new Error(data.error ?? '這附近沒有站牌')
    if (tripStage === 'from') {
      selectedFrom = nearest
      selectedTo = undefined
      fromCoordinate = [latitude, longitude]
      toCoordinate = undefined
      tripStage = 'to'
      interactionMode = 'trip'
      nearbyLayer.clearLayers()
      drawTripEndpoints()
      drawer.replaceChildren(
        drawerBack('取消直達查詢', cancelTripMode),
        heading('再點一下目的地', `出發位置靠近「${nearest.name}」，現在直接點地圖上的目的地。`),
      )
      setStatus(`出發：${nearest.name} · 請點目的地`)
    } else {
      if (selectedFrom?.placeId === nearest.placeId) throw new Error('出發位置和目的地配對到同一站，請選遠一點')
      selectedTo = nearest
      toCoordinate = [latitude, longitude]
      tripStage = 'idle'
      interactionMode = 'trip-results'
      nearbyLayer.clearLayers()
      drawTripEndpoints()
      await loadDirectRoutes()
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '站牌配對失敗', true)
  }
}

async function loadDirectRoutes() {
  if (!activeCity || !selectedFrom || !selectedTo) return
  const from = selectedFrom
  const to = selectedTo
  setStatus(`正在找 ${from.name} → ${to.name} 的直達車…`)
  try {
    const params = new URLSearchParams({ city: activeCity.code, from: from.placeId, to: to.placeId })
    const response = await fetch(`/api/v1/map/direct?${params}`)
    const data = await response.json() as { routes?: DirectRoute[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    if (data.routes.length) {
      const rankedRoutes = await rankDirectRoutesByEta(data.routes)
      lastDirectRoutes = rankedRoutes
      lastTransferPlans = []
      renderDirectRoutes(rankedRoutes)
      await previewDirectRoutes(rankedRoutes)
      return
    }
    setStatus('沒有直達車，正在找一次轉乘…')
    const transferResponse = await fetch(`/api/v1/map/transfer?${params}`)
    const transferData = await transferResponse.json() as { plans?: TransferPlan[]; error?: string }
    if (!transferResponse.ok || !transferData.plans) throw new Error(transferData.error)
    lastDirectRoutes = []
    const rankedPlans = await rankTransferPlansByEta(transferData.plans)
    lastTransferPlans = rankedPlans
    selectedTransferIndex = 0
    renderTransferPlans(rankedPlans)
    await previewTransferPlans(rankedPlans)
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '直達路線查詢失敗', true)
  }
}

async function fetchJourneyEta(legs: Array<{ key: string; patternId: string; sequence: number }>) {
  if (!activeCity || !legs.length) return new Map<string, number | null>()
  try {
    const response = await fetch('/api/v1/map/journey-eta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: activeCity.code, legs }),
    })
    if (!response.ok) return new Map<string, number | null>()
    const data = await response.json() as { estimates?: Array<{ key: string; minutes: number | null }> }
    return new Map((data.estimates ?? []).map((estimate) => [estimate.key, estimate.minutes]))
  } catch {
    return new Map<string, number | null>()
  }
}

async function rankDirectRoutesByEta(routesToRank: DirectRoute[]): Promise<DirectRoute[]> {
  const estimates = await fetchJourneyEta(routesToRank.map((route, index) => ({
    key: `direct:${index}`,
    patternId: route.variantKey,
    sequence: route.boardSequence,
  })))
  return routesToRank.map((route, index) => ({
    ...route,
    etaMinutes: estimates.get(`direct:${index}`) ?? null,
  })).sort((a, b) =>
    (a.etaMinutes ?? Number.POSITIVE_INFINITY) - (b.etaMinutes ?? Number.POSITIVE_INFINITY)
    || a.stopCount - b.stopCount,
  )
}

async function rankTransferPlansByEta(plans: TransferPlan[]): Promise<TransferPlan[]> {
  const estimates = await fetchJourneyEta(plans.flatMap((plan, index) => [
    { key: `transfer:${index}:first`, patternId: plan.first.variantKey, sequence: plan.first.boardSequence },
    { key: `transfer:${index}:second`, patternId: plan.second.variantKey, sequence: plan.second.boardSequence },
  ]))
  return plans.map((plan, index) => {
    const firstEta = estimates.get(`transfer:${index}:first`) ?? null
    const secondEta = estimates.get(`transfer:${index}:second`) ?? null
    const firstRide = plan.first.stopCount * 2
    const secondRide = plan.second.stopCount * 2
    const arrivalAtTransfer = firstEta === null ? null : firstEta + firstRide
    const rawTransferWait = arrivalAtTransfer === null || secondEta === null ? null : secondEta - arrivalAtTransfer
    const transferWait = rawTransferWait !== null && rawTransferWait >= 0 ? rawTransferWait : null
    const connectionStatus = rawTransferWait === null
      ? 'unknown' as const
      : rawTransferWait >= 4
        ? 'comfortable' as const
        : 'tight' as const
    const estimatedTotal = firstEta === null
      ? null
      : firstEta + firstRide + (connectionStatus === 'comfortable' ? transferWait ?? 0 : 20) + secondRide
    return {
      ...plan,
      firstEtaMinutes: firstEta,
      secondEtaMinutes: secondEta,
      transferWaitMinutes: transferWait,
      estimatedTotalMinutes: estimatedTotal,
      connectionStatus,
    }
  }).sort((a, b) =>
    (a.estimatedTotalMinutes ?? Number.POSITIVE_INFINITY) - (b.estimatedTotalMinutes ?? Number.POSITIVE_INFINITY)
    || a.totalStops - b.totalStops,
  )
}

function renderDirectRoutes(directRoutes: DirectRoute[]) {
  if (!selectedFrom || !selectedTo) return
  interactionMode = 'trip-results'
  const list = document.createElement('div')
  list.className = 'direct-route-list'
  if (!directRoutes.length) list.appendChild(paragraph('目前沒有找到直達車。下一版可以接一次轉乘搜尋。'))
  directRoutes.forEach((route, index) => {
    const button = document.createElement('button')
    button.className = 'direct-route-button'
    button.style.setProperty('--route-color', routePalette[index % routePalette.length])
    const top = document.createElement('span')
    const name = document.createElement('strong')
    name.textContent = route.routeName
    const count = document.createElement('span')
    count.textContent = route.etaMinutes === null || route.etaMinutes === undefined
      ? `${route.stopCount} 站`
      : `${route.etaMinutes} 分到站 · ${route.stopCount} 站`
    top.appendChild(name)
    top.appendChild(count)
    const detail = document.createElement('small')
    detail.textContent = route.label
    button.appendChild(top)
    button.appendChild(detail)
    const color = routePalette[index % routePalette.length]
    button.addEventListener('click', () => void loadRoute(route.routeName, route.variantKey, true, color))
    list.appendChild(button)
  })
  const back = drawerBack('重新選目的地', () => {
    selectedTo = undefined
    toCoordinate = undefined
    lastDirectRoutes = []
    tripStage = 'to'
    interactionMode = 'trip'
    previewLayer.clearLayers()
    nearbyLayer.clearLayers()
    drawTripEndpoints()
    drawer.replaceChildren(
      drawerBack('取消直達查詢', cancelTripMode),
      heading('重新選目的地', `保留出發站「${selectedFrom?.name ?? ''}」，請再點一次地圖。`),
    )
    setStatus('已保留出發位置 · 請重新點目的地')
  })
  const reset = tripModeButton()
  drawer.replaceChildren(
    back,
    heading(`${selectedFrom.name} → ${selectedTo.name}`, directRoutes.length ? `${directRoutes.length} 個直達方向，淡色線為候選路線。` : '沒有直達路線'),
    list,
    reset,
  )
  setStatus(directRoutes.length ? `找到 ${directRoutes.length} 個直達方向` : '沒有直達車')
}

function renderTransferPlans(plans: TransferPlan[]) {
  if (!selectedFrom || !selectedTo) return
  interactionMode = 'trip-results'
  const list = document.createElement('div')
  list.className = 'transfer-plan-list'
  if (!plans.length) list.appendChild(paragraph('目前沒有找到合理的一次轉乘方案。'))
  plans.forEach((plan, index) => {
    const card = document.createElement('section')
    card.className = 'transfer-plan'
    card.classList.toggle('selected', index === selectedTransferIndex)
    card.tabIndex = 0
    card.addEventListener('click', () => {
      selectedTransferIndex = index
      renderTransferPlans(plans)
      void previewTransferPlans(plans)
    })
    card.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        card.click()
      }
    })
    const title = document.createElement('div')
    title.className = 'transfer-title'
    const transfer = document.createElement('strong')
    transfer.textContent = `${plan.transferName} 轉乘${plan.transferWalkMeters ? ` · 步行 ${plan.transferWalkMeters} m` : ''}`
    const count = document.createElement('span')
    count.textContent = plan.estimatedTotalMinutes === null || plan.estimatedTotalMinutes === undefined
      ? `共 ${plan.totalStops} 站`
      : plan.connectionStatus === 'tight'
        ? `近期班次偏趕`
        : `約 ${plan.estimatedTotalMinutes} 分`
    title.appendChild(transfer)
    title.appendChild(count)
    if (plan.connectionStatus === 'tight') card.classList.add('connection-tight')
    card.appendChild(title)
    ;[plan.first, plan.second].forEach((leg, legIndex) => {
      const color = routePalette[(index * 2 + legIndex) % routePalette.length]
      const button = document.createElement('button')
      button.className = 'transfer-leg-button'
      button.style.setProperty('--route-color', color)
      const order = document.createElement('span')
      order.textContent = legIndex === 0 ? '先搭' : '再搭'
      const routeName = document.createElement('strong')
      routeName.textContent = leg.routeName
      const stops = document.createElement('small')
      const eta = legIndex === 0 ? plan.firstEtaMinutes : plan.secondEtaMinutes
      stops.textContent = `${eta === null || eta === undefined ? '' : `${eta} 分到站 · `}${leg.stopCount} 站 · ${leg.label}`
      button.appendChild(order)
      button.appendChild(routeName)
      button.appendChild(stops)
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        void loadRoute(leg.routeName, leg.variantKey, true, color)
      })
      card.appendChild(button)
    })
    list.appendChild(card)
  })
  drawer.replaceChildren(
    drawerBack('重新選目的地', resumeDestinationSelection),
    heading(`${selectedFrom.name} → ${selectedTo.name}`, plans.length ? `${plans.length} 個一次轉乘方案` : '沒有直達或一次轉乘方案'),
    list,
    tripModeButton(),
  )
  setStatus(plans.length ? `找到 ${plans.length} 個一次轉乘方案` : '沒有合理的一次轉乘方案')
}

function resumeDestinationSelection() {
  selectedTo = undefined
  toCoordinate = undefined
  lastDirectRoutes = []
  lastTransferPlans = []
  tripStage = 'to'
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  drawTripEndpoints()
  drawer.replaceChildren(
    drawerBack('取消直達查詢', cancelTripMode),
    heading('重新選目的地', `保留出發站「${selectedFrom?.name ?? ''}」，請再點一次地圖。`),
  )
  setStatus('已保留出發位置 · 請重新點目的地')
}

async function previewTransferPlans(plans: TransferPlan[]) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const plan = plans[selectedTransferIndex]
  if (!plan) return
  const legs = [
    { ...plan.first, color: routePalette[(selectedTransferIndex * 2) % routePalette.length] },
    { ...plan.second, color: routePalette[(selectedTransferIndex * 2 + 1) % routePalette.length] },
  ]
  const previews = await Promise.all(legs.map(async (leg) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: leg.routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === leg.variantKey)
    return variant ? { variant, color: leg.color, leg } : null
  }))
  if (requestId !== previewRequest) return
  const bounds = L.latLngBounds([])
  previews.forEach((preview) => {
    if (!preview) return
    const labels = previews.indexOf(preview) % 2 === 0
      ? ['上車', '轉乘'] as const
      : ['轉乘', '下車'] as const
    const line = addJourneyLegPreview(
      preview.variant,
      preview.color,
      preview.leg.boardSequence,
      preview.leg.alightSequence,
      labels,
    )
    bounds.extend(line.getBounds())
  })
  if (fromCoordinate) bounds.extend(fromCoordinate)
  if (toCoordinate) bounds.extend(toCoordinate)
  if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [45, 90], paddingBottomRight: [45, 280] })
}

async function previewDirectRoutes(directRoutes: DirectRoute[]) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(directRoutes.slice(0, 8).map(async (route, index) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === route.variantKey)
    return variant ? { variant, color: routePalette[index % routePalette.length], route } : null
  }))
  if (requestId !== previewRequest) return
  const bounds = L.latLngBounds([])
  previews.forEach((preview) => {
    if (!preview) return
    const line = addJourneyLegPreview(
      preview.variant,
      preview.color,
      preview.route.boardSequence,
      preview.route.alightSequence,
      ['上車', '下車'],
    )
    bounds.extend(line.getBounds())
  })
  if (selectedFrom) bounds.extend([selectedFrom.latitude, selectedFrom.longitude])
  if (selectedTo) bounds.extend([selectedTo.latitude, selectedTo.longitude])
  if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [45, 90], paddingBottomRight: [45, 280] })
}

async function previewPlaceRoutes(placeRoutes: PlaceRoute[], place: NearbyPlace) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(placeRoutes.slice(0, 8).map(async (route, index) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === route.variantKey)
    return variant ? { variant, color: routePalette[index % routePalette.length] } : null
  }))
  if (requestId !== previewRequest) return
  previews.forEach((preview) => {
    if (!preview) return
    addSelectablePreview(preview.variant, preview.color, false, () => void showPlaceRoutes(place))
  })
}

function addSelectablePreview(
  variant: RouteMapVariant,
  color: string,
  returnToTrip: boolean,
  backAction?: () => void,
): LeafletGeoJSON {
  const normalStyle = { color, weight: 5.5, opacity: .62, lineCap: 'round' as const, lineJoin: 'round' as const }
  const line = L.geoJSON(variant.shape, { pane: 'routePreviewPane', style: normalStyle }).addTo(previewLayer)
  line.bindTooltip(`${variant.routeName} · ${variant.label}`, { sticky: true })
  line.on('mouseover', () => {
    line.setStyle({ ...normalStyle, weight: 8, opacity: .9 })
    line.eachLayer((layer) => {
      if (layer instanceof L.Path) layer.bringToFront()
    })
  })
  line.on('mouseout', () => line.setStyle(normalStyle))
  line.on('click', (event) => {
    L.DomEvent.stopPropagation(event)
    void loadRoute(variant.routeName, variant.variantKey, returnToTrip, color, backAction)
  })
  return line
}

function addJourneyLegPreview(
  variant: RouteMapVariant,
  color: string,
  boardSequence: number,
  alightSequence: number,
  labels: readonly [string, string],
): LeafletGeoJSON {
  const fullLine = L.geoJSON(variant.shape, {
    pane: 'routePreviewPane',
    style: { color, weight: 3.5, opacity: .2, lineCap: 'round', lineJoin: 'round' },
  }).addTo(previewLayer)
  fullLine.bindTooltip(`${variant.routeName} · ${variant.label}`, { sticky: true })
  fullLine.on('click', (event) => {
    L.DomEvent.stopPropagation(event)
    void loadRoute(variant.routeName, variant.variantKey, true, color)
  })

  const board = variant.stops.features.find((stop) => stop.properties.sequence === boardSequence)
  const alight = variant.stops.features.find((stop) => stop.properties.sequence === alightSequence)
  if (!board || !alight) return fullLine

  L.geoJSON(variant.stops, {
    pane: 'stopPane',
    pointToLayer: (_feature, latlng) => L.circleMarker(latlng, {
      pane: 'stopPane', radius: 2.4, weight: 1, color: '#fffaf0', fillColor: color, fillOpacity: .35,
      interactive: false,
    }),
  }).addTo(previewLayer)

  const coordinates = variant.shape.geometry.coordinates as Array<[number, number]>
  const matches = matchStopsToShape(variant.stops.features.map((stop) => ({
    sequence: stop.properties.sequence,
    coordinates: stop.geometry.coordinates as [number, number],
  })), coordinates)
  const boardIndex = matches.get(boardSequence) ?? nearestCoordinateIndex(coordinates, board.geometry.coordinates)
  const alightIndex = matches.get(alightSequence) ?? nearestCoordinateIndex(coordinates, alight.geometry.coordinates)
  const start = Math.min(boardIndex, alightIndex)
  const end = Math.max(boardIndex, alightIndex)
  const segmentCoordinates = coordinates.slice(start, end + 1)
  if (segmentCoordinates.length >= 2) {
    const segmentFeature: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: segmentCoordinates },
    }
    const segment = L.geoJSON(segmentFeature, {
      pane: 'routePreviewPane',
      style: { color, weight: 7, opacity: .92, lineCap: 'round', lineJoin: 'round' },
    }).addTo(previewLayer)
    segment.bindTooltip(`${variant.routeName} · ${board.properties.stopName} → ${alight.properties.stopName}`, { sticky: true })
    segment.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      void loadRoute(variant.routeName, variant.variantKey, true, color)
    })
  }

  ;[[board, labels[0]], [alight, labels[1]]].forEach(([stop, label]) => {
    const feature = stop as typeof board
    const [longitude, latitude] = feature.geometry.coordinates
    unifiedStopMarker([latitude, longitude], true, color)
      .bindTooltip(`${label} · ${feature.properties.stopName}`, { permanent: true, direction: 'top' })
      .addTo(previewLayer)
  })
  return fullLine
}

function nearestCoordinateIndex(coordinates: GeoJSON.Position[], target: GeoJSON.Position): number {
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  coordinates.forEach(([longitude, latitude], index) => {
    const deltaLongitude = longitude - target[0]
    const deltaLatitude = latitude - target[1]
    const distance = deltaLongitude * deltaLongitude + deltaLatitude * deltaLatitude
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  })
  return nearest
}

async function openPlaceById(placeId: string) {
  if (!activeCity) return
  const response = await fetch(`/api/v1/map/place/${encodeURIComponent(placeId)}?city=${encodeURIComponent(activeCity.code)}`)
  const data = await response.json() as { place?: NearbyPlace; error?: string }
  if (!response.ok || !data.place) throw new Error(data.error || '找不到這個站牌')
  map.setView([data.place.latitude, data.place.longitude], 16)
  lastNearbyOrigin = [data.place.latitude, data.place.longitude]
  lastNearbyPlaces = [data.place]
  interactionMode = 'nearby'
  await showPlaceRoutes(data.place)
}

type StoredBoard = {
  version?: number
  id: string
  title: string
  placeId?: string
  city?: string
  latitude?: number
  longitude?: number
  buses: Array<Record<string, unknown>>
  createdAt?: string
  updatedAt?: string
}

function readBoards(): StoredBoard[] {
  try {
    const value = JSON.parse(localStorage.getItem(BOARDS_KEY) || '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function placeRouteRank(route: PlaceRoute, frequency: Map<string, number>): number {
  const eta = route.estimateSeconds === null ? 1_000_000 : route.estimateSeconds
  return eta - Math.min(frequency.get(route.routeUid) ?? 0, 5) * 15
}

function favoritePlaceButton(place: NearbyPlace, placeRoutes: PlaceRoute[]): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'favorite-place-button'
  const existing = readBoards().find((board) => board.city === activeCity?.code && board.placeId === place.placeId)
  button.textContent = existing ? '已在首頁' : '加入首頁'
  button.disabled = Boolean(existing)
  button.addEventListener('click', () => {
    if (!activeCity) return
    const boards = readBoards()
    const now = new Date().toISOString()
    const uniqueRoutes = [...new Map(placeRoutes.map((route) => [
      `${route.routeUid}:${route.stopUid}:${route.direction}`,
      route,
    ])).values()].slice(0, 8)
    const board = {
      version: 2,
      id: crypto.randomUUID?.() || String(Date.now()),
      title: place.name,
      city: activeCity.code,
      placeId: place.placeId,
      latitude: place.latitude,
      longitude: place.longitude,
      buses: uniqueRoutes.map((route) => ({
        city: activeCity!.code,
        routeName: route.routeName,
        routeUid: route.routeUid,
        stopName: route.stopName,
        stopUid: route.stopUid,
        direction: route.direction,
      })),
      createdAt: now,
      updatedAt: now,
    }
    boards.push(board)
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards))
    localStorage.setItem(ACTIVE_BOARD_KEY, board.id)
    button.textContent = '已加入首頁'
    button.disabled = true
  })
  return button
}

function favoriteDirectionButton(place: NearbyPlace, route: PlaceRoute): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'favorite-direction-button'
  const routeKey = `${route.routeUid}:${route.stopUid}:${route.direction}`
  const existing = readBoards().find((board) =>
    board.city === activeCity?.code
    && board.placeId === place.placeId
    && board.buses.some((bus) => `${bus.routeUid}:${bus.stopUid}:${bus.direction}` === routeKey),
  )
  button.textContent = existing ? '✓' : '＋'
  button.title = existing ? '已在首頁' : '將這個方向加入首頁'
  button.setAttribute('aria-label', button.title)
  button.disabled = Boolean(existing)
  button.addEventListener('click', () => {
    if (!activeCity) return
    const boards = readBoards()
    const now = new Date().toISOString()
    const bus = {
      city: activeCity.code,
      routeName: route.routeName,
      routeUid: route.routeUid,
      stopName: route.stopName,
      stopUid: route.stopUid,
      direction: route.direction,
      directionLabel: route.label,
    }
    let board: StoredBoard | undefined = boards.find((item) => item.city === activeCity!.code && item.placeId === place.placeId)
    if (board) board.buses.push(bus)
    else {
      const newBoard: StoredBoard = {
        version: 2,
        id: crypto.randomUUID?.() || String(Date.now()),
        title: place.name,
        city: activeCity.code,
        placeId: place.placeId,
        latitude: place.latitude,
        longitude: place.longitude,
        buses: [bus],
        createdAt: now,
        updatedAt: now,
      }
      boards.push(newBoard)
      board = newBoard
    }
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards))
    localStorage.setItem(ACTIVE_BOARD_KEY, board.id)
    button.textContent = '✓'
    button.title = '已在首頁'
    button.disabled = true
  })
  return button
}

function directionFavoriteControl(place: NearbyPlace, route: PlaceRoute): HTMLButtonElement {
  const control = document.createElement('button')
  control.className = 'favorite-direction-button'
  const key = `${route.routeUid}:${route.stopUid}:${route.direction}:${route.label}`
  const matches = (bus: Record<string, unknown>) =>
    `${bus.routeUid}:${bus.stopUid}:${bus.direction}:${bus.directionLabel ?? ''}` === key
  let selected = readBoards().some((board) =>
    board.city === activeCity?.code && board.placeId === place.placeId && board.buses.some(matches),
  )

  const render = () => {
    control.textContent = selected ? '×' : '＋'
    control.title = selected ? '從首頁移除這個方向' : '將這個方向加入首頁'
    control.setAttribute('aria-label', control.title)
    control.classList.toggle('selected', selected)
  }

  control.addEventListener('click', () => {
    if (!activeCity) return
    const boards = readBoards()
    const boardIndex = boards.findIndex((board) => board.city === activeCity!.code && board.placeId === place.placeId)
    if (selected && boardIndex >= 0) {
      boards[boardIndex].buses = boards[boardIndex].buses.filter((bus) => !matches(bus))
      if (!boards[boardIndex].buses.length) boards.splice(boardIndex, 1)
      selected = false
    } else {
      const bus = {
        city: activeCity.code,
        routeName: route.routeName,
        routeUid: route.routeUid,
        stopName: route.stopName,
        stopUid: route.stopUid,
        direction: route.direction,
        directionLabel: route.label,
      }
      if (boardIndex >= 0) boards[boardIndex].buses.push(bus)
      else boards.push({
        version: 2,
        id: crypto.randomUUID?.() || String(Date.now()),
        title: place.name,
        city: activeCity.code,
        placeId: place.placeId,
        latitude: place.latitude,
        longitude: place.longitude,
        buses: [bus],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      selected = true
    }
    localStorage.setItem(BOARDS_KEY, JSON.stringify(boards))
    const selectedBoard = boards.find((board) => board.city === activeCity!.code && board.placeId === place.placeId)
    if (selectedBoard) localStorage.setItem(ACTIVE_BOARD_KEY, selectedBoard.id)
    else if (localStorage.getItem(ACTIVE_BOARD_KEY) && !boards.some((board) => board.id === localStorage.getItem(ACTIVE_BOARD_KEY))) {
      if (boards[0]) localStorage.setItem(ACTIVE_BOARD_KEY, boards[0].id)
      else localStorage.removeItem(ACTIVE_BOARD_KEY)
    }
    render()
  })
  render()
  return control
}

async function showPlaceRoutes(place: NearbyPlace) {
  if (!activeCity) return
  const placeRequest = ++previewRequest
  previewLayer.clearLayers()
  routeLayer.clearLayers()
  stopMarkers = []
  const loadingList = document.createElement('div')
  loadingList.className = 'place-route-loading'
  for (let index = 0; index < 3; index += 1) {
    const skeleton = document.createElement('div')
    skeleton.className = 'place-route-skeleton'
    loadingList.appendChild(skeleton)
  }
  drawer.replaceChildren(
    drawerBack('附近站牌', renderNearbyPlaces),
    heading(place.name, '正在取得路線與到站時間'),
    loadingList,
  )
  setStatus(`正在讀取 ${place.name} 的路線…`)
  try {
    const response = await fetch(`/api/v1/map/place/${encodeURIComponent(place.placeId)}/routes?city=${encodeURIComponent(activeCity.code)}`)
    const data = await response.json() as { routes?: PlaceRoute[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    if (placeRequest !== previewRequest) return
    const frequency = new Map<string, number>()
    readBoards().flatMap((board) => board.buses).forEach((bus) => {
      const routeUid = typeof bus.routeUid === 'string' ? bus.routeUid : ''
      if (routeUid) frequency.set(routeUid, (frequency.get(routeUid) ?? 0) + 1)
    })
    const sortedRoutes = [...data.routes].sort((a, b) =>
      placeRouteRank(a, frequency) - placeRouteRank(b, frequency)
      || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }),
    )
    const list = document.createElement('div')
    list.className = 'place-route-list'
    for (const [index, route] of sortedRoutes.entries()) {
      const row = document.createElement('div')
      row.className = 'place-route-row'
      const button = document.createElement('button')
      button.className = 'place-route-button'
      const color = routePalette[index % routePalette.length]
      row.style.setProperty('--route-color', color)
      const line = document.createElement('span')
      const routeName = document.createElement('strong')
      routeName.textContent = route.routeName
      const direction = document.createElement('span')
      direction.textContent = route.label
      const eta = document.createElement('b')
      eta.className = 'place-route-eta'
      eta.textContent = route.etaLabel
      line.appendChild(routeName)
      line.appendChild(eta)
      const detail = document.createElement('small')
      detail.textContent = route.label
      button.appendChild(line)
      button.appendChild(detail)
      button.addEventListener('click', () => void loadRoute(
        route.routeName,
        route.variantKey,
        false,
        color,
        () => void showPlaceRoutes(place),
      ))
      row.appendChild(button)
      row.appendChild(directionFavoriteControl(place, route))
      list.appendChild(row)
    }
    drawer.replaceChildren(
      drawerBack('附近站牌', renderNearbyPlaces),
      heading(place.name, `${Math.round(place.distanceMeters)} 公尺 · ${data.routes.length} 個行車方向`),
      list,
    )
    await previewPlaceRoutes(sortedRoutes, place)
    drawTripEndpoints()
    map.panTo([place.latitude, place.longitude])
    history.replaceState(null, '', `/map?city=${activeCity.code}&place=${encodeURIComponent(place.placeId)}`)
    setStatus(`${place.name} · ${data.routes.length} 個行車方向`)
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '站牌路線讀取失敗', true)
  }
}

function heading(title: string, description: string): HTMLElement {
  const wrapper = document.createElement('div')
  wrapper.className = 'drawer-heading'
  const heading = document.createElement('h1')
  heading.textContent = title
  const paragraph = document.createElement('p')
  paragraph.textContent = description
  wrapper.appendChild(heading)
  wrapper.appendChild(paragraph)
  return wrapper
}

function paragraph(text: string): HTMLElement {
  const node = document.createElement('p')
  node.className = 'drawer-copy'
  node.textContent = text
  return node
}

function drawerBack(label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'drawer-back'
  button.textContent = `← ${label}`
  button.addEventListener('click', onClick)
  return button
}

function buttonGrid(items: Array<{ label: string; onClick: () => void }>): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'selection-grid'
  for (const item of items) {
    const button = document.createElement('button')
    button.textContent = item.label
    button.addEventListener('click', item.onClick)
    grid.appendChild(button)
  }
  return grid
}

function setStatus(text: string, error = false) {
  statusNode.textContent = text
  statusNode.classList.toggle('error', error)
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}
