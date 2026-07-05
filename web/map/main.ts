import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { matchStopsToShape } from '../../src/domain/map/shape-matcher'
import {
  getActiveCity,
  isFavoriteDirection,
  readBoards,
  setActiveCity,
  toggleFavoriteDirection,
  type FavoriteBus,
} from '../boards/store'
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
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopName: string
  stopSequence: number
  estimateSeconds: number | null
  etaLabel: string
  stopStatus: number
  source?: 'realtime' | 'stale-realtime' | 'schedule' | 'none'
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

// 觸控裝置沒有 hover、手指也比游標粗得多,才需要放大命中範圍;
// 滑鼠本身夠精準,放大命中範圍反而讓 hover 判定跟不上游標移動(看起來卡住不會變回原狀)。
const hoverCapable = window.matchMedia('(hover: hover)').matches

// 手機的返回鍵/返回手勢應該退回上一層畫面,不是直接離開整個地圖。
// 做法:只維護「一個」history 哨兵——離開全台總覽時 push 一筆,
// popstate(使用者按返回)時執行目前畫面的返回動作,退完還沒到根層就再補推一筆。
// 各畫面照常用 replaceState 更新網址;哨兵只負責把「返回」這個動作攔下來。
let viewBackAction: (() => void) | undefined
let historySentinel = false
let skipNextPop = false

function setViewBack(back?: () => void) {
  viewBackAction = back
  if (back && !historySentinel) {
    history.pushState({ mochi: true }, '', location.href)
    historySentinel = true
  } else if (!back && historySentinel) {
    // 經 UI 按鈕回到根層:把哨兵吃掉,下一次瀏覽器返回才會真的離開地圖。
    historySentinel = false
    skipNextPop = true
    history.back()
  }
}

window.addEventListener('popstate', () => {
  if (skipNextPop) {
    skipNextPop = false
    // 被吃掉的哨兵底下那筆網址可能還停在舊畫面(例如 deep link),校正回根層網址。
    history.replaceState(null, '', '/map')
    return
  }
  if (!historySentinel) return
  historySentinel = false
  const back = viewBackAction
  viewBackAction = undefined
  back?.()
})

// 互動圖層一律用 SVG:canvas 會以整張地圖大小攔截點擊,
// 疊在上層的 pane 會擋住下層線條的 click(候選路線點不到、誤觸地圖點擊)。
const map = L.map(mapNode, {
  zoomControl: false,
  minZoom: 6,
  maxZoom: 19,
}).setView([23.75, 120.9], 7)

map.createPane('routePreviewPane').style.zIndex = '420'
// 預覽小站點獨立一層:同 pane 內只看插入順序,多條建議路線輪流蓋掉
// 彼此的小點;墊在預覽線之上、選定路線與互動圓點之下才穩。
map.createPane('previewDotPane').style.zIndex = '425'
map.createPane('routePane').style.zIndex = '440'
map.createPane('stopPane').style.zIndex = '480'
map.createPane('networkPane').style.zIndex = '410'
map.createPane('vehiclePane').style.zIndex = '520'

// 全路網一次畫數百條線與站點,效能上仍用 canvas;
// networkPane 在所有互動 pane 之下,canvas 攔截不會影響其他圖層。
// tolerance 只在觸控裝置放大,滑鼠維持原生線寬判定,hover 才會跟手即時復原。
const networkRenderer = L.canvas({ pane: 'networkPane', tolerance: hoverCapable ? 0 : 12 })

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
// routes 屬於哪個縣市:深連結直接進路線不會經過 chooseCity,目錄是空的
let routesCityCode: string | undefined
let category = '全部'
let stopMarkers: L.CircleMarker[] = []
let lastNearbyPlaces: NearbyPlace[] = []
let lastNearbyOrigin: [number, number] | undefined
let selectedFrom: NearbyPlace | undefined
let selectedTo: NearbyPlace | undefined
let fromCoordinate: [number, number] | undefined
let toCoordinate: [number, number] | undefined
let tripStage: 'idle' | 'from' | 'to' = 'idle'
let tripSelecting = false
let lastDirectRoutes: DirectRoute[] = []
let lastTransferPlans: TransferPlan[] = []
let interactionMode: 'browse' | 'nearby' | 'trip' | 'trip-results' | 'route' = 'browse'
let routeReturnsToTrip = false
let activeRouteColor = '#b85f49'
let previewRequest = 0
let selectedTransferIndex = 0
let routeBackAction: (() => void) | undefined
let routeBackLabel = '更換路線'
// 經過支線選擇進來的路線,「更換」要退回支線選擇(一層),不能直接跳回路線列表(兩層)。
let lastVariantChoices: { routeName: string; variants: RouteMapVariant[] } | undefined
let variantPickerUsed = false
let networkVisible = false
let networkCache: { city: string; data: CityNetwork } | undefined
let networkStopMarkers: L.CircleMarker[] = []
let vehicleRefreshTimer: number | undefined

const routePalette = ['#b85f49', '#4f685b', '#55718a', '#b08a47', '#765b78', '#6f7561']

// 依路線名稱 hash 配色:同一條路線在清單、預覽、路線頁永遠同色,
// 使用者才能建立「路線=顏色」的連結;依清單位置配色會讓顏色隨排序漂移。
function routeColor(routeName: string): string {
  let hash = 2166136261
  for (const char of routeName) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619)
  return routePalette[(hash >>> 0) % routePalette.length]
}

// 轉乘兩段撞色時把第二段移到下一個色格,乘車段落才分得開。
function transferLegColors(first: string, second: string): [string, string] {
  const firstColor = routeColor(first)
  let secondColor = routeColor(second)
  if (secondColor === firstColor) {
    secondColor = routePalette[(routePalette.indexOf(firstColor) + 1) % routePalette.length]
  }
  return [firstColor, secondColor]
}

// 觸控裝置沒有 hover,tooltip 會在點按瞬間彈出並蓋住點擊目標,直接不綁。
function bindHoverTooltip<T extends L.Layer>(layer: T, content: string | HTMLElement, options?: L.TooltipOptions): T {
  if (hoverCapable) layer.bindTooltip(content, options)
  return layer
}

// 觸控裝置沒有 hover 也沒有游標精準度,才需要疊一條同幾何的透明胖線接事件;
// 滑鼠夠精準,直接讓可見線本身接互動,hover 判定才會跟著游標即時進出。
function bindSelectableLine(
  shape: RouteMapVariant['shape'],
  pane: string,
  layerGroup: L.LayerGroup,
  style: L.PathOptions,
): { line: LeafletGeoJSON; target: LeafletGeoJSON } {
  if (hoverCapable) {
    const line = L.geoJSON(shape, { pane, style }).addTo(layerGroup)
    return { line, target: line }
  }
  const line = L.geoJSON(shape, { pane, style: { ...style, interactive: false } }).addTo(layerGroup)
  const hit = L.geoJSON(shape, {
    pane,
    style: { color: '#000', opacity: 0, weight: 26, lineCap: 'round', lineJoin: 'round' },
  }).addTo(layerGroup)
  return { line, target: hit }
}

// 預覽淡線也標出小站點(跟全路網的小圓點同款),看得出停靠密度與站距。
// 放在 previewDotPane:壓在預覽線之上(不會被建議路線的粗段蓋掉),
// 但仍墊在附近站牌等互動大圓點(stopPane)之下,不能蓋住它們。
// 尺寸隨 zoom 走但始終小於 stopPane 的互動圓點,放大才不會縮成針尖。
const previewStopDots = new Set<L.CircleMarker>()

function previewDotStyleForZoom(zoom: number): { radius: number; weight: number } {
  if (zoom >= 16) return { radius: 5, weight: 1.4 }
  if (zoom >= 14) return { radius: 3.5, weight: 1.2 }
  if (zoom >= 12) return { radius: 2.4, weight: 1 }
  return { radius: 1.8, weight: 1 }
}

function addPreviewStopDots(
  stops: RouteMapVariant['stops'],
  color: string,
  layerGroup: L.LayerGroup,
): void {
  const { radius, weight } = previewDotStyleForZoom(map.getZoom())
  L.geoJSON(stops, {
    pane: 'previewDotPane',
    pointToLayer: (_feature, latlng) => {
      const dot = L.circleMarker(latlng, {
        pane: 'previewDotPane', radius, weight, color: '#fffaf0', fillColor: color, fillOpacity: .6,
        interactive: false,
      })
      previewStopDots.add(dot)
      return dot
    },
  }).addTo(layerGroup)
}

void initialise()

async function initialise() {
  try {
    const response = await fetch('/api/v1/map/cities')
    const data = await response.json() as { cities: MapCity[] }
    cities = data.cities
    const params = new URLSearchParams(location.search)
    const cityCode = params.get('city') || getActiveCity()
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
// 品牌鍵 = 回到全台總覽(留在地圖內);右上「首頁」才是離開地圖的出口。
document.getElementById('map-brand')?.addEventListener('click', (event) => {
  event.preventDefault()
  showTaiwan()
  history.replaceState(null, '', '/map')
})
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
    locateCityButton(),
  )
  history.replaceState(null, '', '/map')
  setViewBack(undefined)
}

// 「跳到你所在的縣市」用 Cloudflare 依連線 IP 推估的粗略位置(縣市級),
// 完全不觸發瀏覽器定位授權;精度只夠選縣市,所以不拿來找站牌。
function locateCityButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'locate-button'
  button.textContent = '跳到你所在的縣市'
  button.addEventListener('click', () => void jumpToNearestCity(button))
  return button
}

async function jumpToNearestCity(button: HTMLButtonElement) {
  button.disabled = true
  button.textContent = '正在判斷你的位置…'
  try {
    const response = await fetch('/api/v1/map/locate', { cache: 'no-store' })
    const data = await response.json() as { latitude?: number; longitude?: number; error?: string }
    if (!response.ok || typeof data.latitude !== 'number' || typeof data.longitude !== 'number' || !cities.length) {
      throw new Error(data.error || '這次判斷不出位置，直接手動選吧')
    }
    const origin: [number, number] = [data.latitude, data.longitude]
    const nearest = cities.reduce((best, city) =>
      coarseKilometers(city.center, origin) < coarseKilometers(best.center, origin) ? city : best)
    // 離最近縣市中心太遠,代表人大概不在台灣(或 IP 出口在國外),硬跳只會誤導。
    if (coarseKilometers(nearest.center, origin) > 150) throw new Error('看起來你不在台灣附近，直接手動選吧')
    await chooseCity(nearest)
    setStatus(`依網路位置猜你在${nearest.name}，猜錯就按「返回縣市」重選。`)
  } catch (error) {
    setStatus(error instanceof Error && error.message ? error.message : '定位失敗，直接手動選吧', true)
    button.disabled = false
    button.textContent = '跳到你所在的縣市'
  }
}

// 粗略公里距離(等距圓柱近似),挑最近縣市夠用。
function coarseKilometers(a: [number, number], b: [number, number]): number {
  const kmLat = (a[0] - b[0]) * 110.6
  const kmLon = (a[1] - b[1]) * 111.3 * Math.cos(((a[0] + b[0]) / 2) * Math.PI / 180)
  return Math.sqrt(kmLat * kmLat + kmLon * kmLon)
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
  setViewBack(showTaiwan)
}

async function chooseCity(city: MapCity) {
  stopVehicleRefresh()
  activeCity = city
  setActiveCity(city.code)
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
  setViewBack(() => showRegion(city.region))

  try {
    const response = await fetch(`/api/v1/map/routes?city=${encodeURIComponent(city.code)}`)
    const data = await response.json() as { routes?: RouteItem[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    routes = data.routes
    routesCityCode = city.code
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
  if (!routes.length || routesCityCode !== activeCity.code) {
    // 深連結直接進路線(沒經過 chooseCity)後按返回會走到這:目錄還沒載,
    // 先補抓再重畫,不然會看到一片空白的路線選單。
    drawer.replaceChildren(
      drawerBack('返回縣市', () => showRegion(activeCity!.region)),
      heading(activeCity.name, '正在載入路線…'),
    )
    setViewBack(() => { if (activeCity) showRegion(activeCity.region) })
    const cityCode = activeCity.code
    void (async () => {
      try {
        const response = await fetch(`/api/v1/map/routes?city=${encodeURIComponent(cityCode)}`)
        const data = await response.json() as { routes?: RouteItem[]; error?: string }
        if (!response.ok || !data.routes) throw new Error(data.error)
        routes = data.routes
        routesCityCode = cityCode
        category = '全部'
        // 載回來時使用者可能已經離開選單(開了路線、換了城市),別把畫面搶回來
        if (interactionMode === 'browse' && activeCity?.code === cityCode) renderRoutePicker()
      } catch {
        setStatus('目前無法載入這個縣市的路線。', true)
      }
    })()
    return
  }
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
  setViewBack(() => { if (activeCity) showRegion(activeCity.region) })
}

function tripModeButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'trip-mode-button'
  button.textContent = '↗'
  button.title = '路線規劃'
  button.setAttribute('aria-label', '路線規劃：選擇出發位置與目的地')
  button.addEventListener('click', () => {
    selectedFrom = undefined
    selectedTo = undefined
    fromCoordinate = undefined
    toCoordinate = undefined
    lastDirectRoutes = []
    lastTransferPlans = []
    tripStage = 'from'
    interactionMode = 'trip'
    // 全路網開著就留著:小站點正好當選點的瞄準參考,等終點選完才收
    previewLayer.clearLayers()
    routeLayer.clearLayers()
    nearbyLayer.clearLayers()
    drawer.replaceChildren(
      drawerBack('取消路線規劃', cancelTripMode),
      heading('點一下出發位置', '直接點地圖，系統會配對最近站牌。'),
    )
    setStatus('路線規劃 · 請點出發位置')
    setViewBack(cancelTripMode)
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

function hasTripResults(): boolean {
  return Boolean(selectedFrom && selectedTo && (lastDirectRoutes.length || lastTransferPlans.length))
}

// 從岔出去的畫面(檢視候選路線、附近站牌)回到行程候選清單。
// 行程結果只在明確出口丟棄(路線列表、取消規劃、換城市),
// 中途點站牌、開路線都保留狀態,靠這裡回得來。
function returnToTripResults() {
  if (!hasTripResults()) {
    renderRoutePicker()
    return
  }
  interactionMode = 'trip-results'
  routeReturnsToTrip = false
  // 選中的路線畫在 routeLayer、車輛有自己的計時器,回候選清單時一併收掉
  stopVehicleRefresh()
  routeLayer.clearLayers()
  stopMarkers = []
  nearbyLayer.clearLayers()
  if (lastDirectRoutes.length) {
    renderDirectRoutes(lastDirectRoutes)
    void previewDirectRoutes(lastDirectRoutes)
  } else {
    renderTransferPlans(lastTransferPlans)
    void previewTransferPlans(lastTransferPlans)
  }
  drawTripEndpoints()
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
  if (!returnToTrip && !hasTripResults()) clearTripState()
  // 載入中(和載入失敗時)的返回也要指對地方:從行程候選進來的,
  // 退路是候選清單;指到 renderRoutePicker 會把整趟規劃清掉。
  const loadingBack = returnToTrip ? returnToTripResults : backAction ?? renderRoutePicker
  const loadingLabel = returnToTrip ? '返回行程候選' : backAction ? '返回站點' : '返回路線'
  setStatus(`${routeName} · 正在讀取城市裡的路徑…`)
  drawer.replaceChildren(drawerBack(loadingLabel, loadingBack), heading(routeName, '正在拼起路線與站牌…'))
  setViewBack(loadingBack)
  try {
    const params = new URLSearchParams({ city: activeCity.code, route: routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    const data = await response.json() as { variants?: RouteMapVariant[]; error?: string }
    if (!response.ok || !data.variants?.length) throw new Error(data.error)
    const preferred = data.variants.find((variant) => variant.variantKey === preferredVariant)
    lastVariantChoices = { routeName, variants: data.variants }
    variantPickerUsed = !preferred && data.variants.length > 1
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
  // 支線選擇要能在地圖上比較走向:全部畫出來,列表與線用同色對應。
  // 這裡的顏色是「支線區分色」,刻意不用 routeColor(同一條路線的支線會全部同色)。
  previewRequest += 1
  stopVehicleRefresh()
  previewLayer.clearLayers()
  routeLayer.clearLayers()
  nearbyLayer.clearLayers()
  stopMarkers = []
  const bounds = L.latLngBounds([])
  const previewsByKey = new Map<string, { line: LeafletGeoJSON; style: L.PathOptions }>()
  variants.forEach((variant, index) => {
    const color = routePalette[index % routePalette.length]
    const style = { color, weight: 5.5, opacity: .62, lineCap: 'round' as const, lineJoin: 'round' as const }
    const { line, target } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, style)
    addPreviewStopDots(variant.stops, color, previewLayer)
    bindHoverTooltip(target, `${variant.label} · ${variant.subRouteName}`, { sticky: true })
    target.on('mouseover', () => line.setStyle({ ...style, weight: 8, opacity: .9 }))
    target.on('mouseout', () => line.setStyle(style))
    target.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      drawVariant(variant)
    })
    previewsByKey.set(variant.variantKey, { line, style })
    bounds.extend(line.getBounds())
  })
  if (bounds.isValid()) map.fitBounds(bounds, { paddingTopLeft: [40, 90], paddingBottomRight: [40, 260] })

  const list = document.createElement('div')
  list.className = 'variant-list'
  list.replaceChildren(...variants.map((variant, index) => {
    const button = document.createElement('button')
    button.className = 'variant-button'
    button.style.borderLeft = `4px solid ${routePalette[index % routePalette.length]}`
    const strong = document.createElement('strong')
    strong.textContent = variant.label
    const small = document.createElement('span')
    small.textContent = variant.subRouteName
    button.appendChild(strong)
    button.appendChild(small)
    button.addEventListener('click', () => drawVariant(variant))
    button.addEventListener('mouseenter', () => {
      const preview = previewsByKey.get(variant.variantKey)
      preview?.line.setStyle({ ...preview.style, weight: 8, opacity: .9 })
    })
    button.addEventListener('mouseleave', () => {
      const preview = previewsByKey.get(variant.variantKey)
      preview?.line.setStyle(preview.style)
    })
    return button
  }))
  // 行程候選帶著過期的 variantKey 進來時會落到這裡,退路一樣要回候選清單
  const variantBack = routeReturnsToTrip ? returnToTripResults : routeBackAction ?? renderRoutePicker
  const variantBackLabel = routeReturnsToTrip ? '返回行程候選' : routeBackAction ? '返回站點' : '返回路線'
  drawer.replaceChildren(
    drawerBack(variantBackLabel, variantBack),
    heading(routeName, '同一路線可能穿過不同街廓，點線或點列表選一條。'),
    list,
  )
  setViewBack(variantBack)
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
      const marker = bindHoverTooltip(unifiedStopMarker(latlng), `${feature.properties.sequence}. ${feature.properties.stopName}`, {
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
  const canReturnToVariantPicker = !routeReturnsToTrip
    && variantPickerUsed
    && lastVariantChoices?.routeName === variant.routeName
    && (lastVariantChoices?.variants.length ?? 0) > 1
  const change = document.createElement('button')
  change.className = 'quiet-button'
  change.textContent = routeReturnsToTrip
    ? '返回行程候選'
    : canReturnToVariantPicker ? '更換方向' : routeBackLabel
  const goBack = () => {
    if (routeReturnsToTrip && hasTripResults()) {
      returnToTripResults()
    } else if (canReturnToVariantPicker && lastVariantChoices) {
      // 從支線選擇進來的,退回支線選擇(一層);直接跳路線列表會一次退兩層。
      renderVariantPicker(lastVariantChoices.routeName, lastVariantChoices.variants)
      setStatus(`${lastVariantChoices.routeName} · 選擇行駛方向`)
    } else if (routeBackAction) routeBackAction()
    else renderRoutePicker()
  }
  change.addEventListener('click', goBack)
  drawer.replaceChildren(
    heading(variant.routeName, variant.label),
    paragraph(variant.subRouteName),
    change,
  )
  setViewBack(goBack)
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
  // 預覽小點由 previewLayer.clearLayers() 收掉,這裡順手把已離場的踢出集合。
  const previewStyle = previewDotStyleForZoom(map.getZoom())
  previewStopDots.forEach((dot) => {
    if (!map.hasLayer(dot)) {
      previewStopDots.delete(dot)
      return
    }
    dot.setStyle(previewStyle)
  })
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
        bindHoverTooltip(marker, tooltip).addTo(vehicleLayer)
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
  // 淡線是刻意的:全路網數百條線只當背景,站點與 hover 強調才是主角
  const networkLineStyle = { weight: 2.6, opacity: .34, lineCap: 'round' as const, lineJoin: 'round' as const }
  network.routes.forEach((route) => {
    const color = routeColor(route.routeName)
    const line = L.geoJSON(route.shape, {
      // renderer 屬於 PathOptions,經 resetStyle 併入 layer options,在加入地圖前生效。
      style: { renderer: networkRenderer, color, ...networkLineStyle },
    })
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        // 路線規劃進行中,點到背景線只是瞄準地圖,當一般選點處理
        if (tripStage !== 'idle') {
          const { latlng } = event as L.LeafletMouseEvent
          void selectTripCoordinate(latlng.lat, latlng.lng)
          return
        }
        void loadRoute(route.routeName, route.variantKey, false, color)
      })
      .addTo(networkLayer)
    bindHoverTooltip(line, `${route.routeName} · ${route.label}`, { sticky: true })
    line.on('mouseover', () => line.setStyle({ weight: 5, opacity: .75 }))
    line.on('mouseout', () => line.setStyle(networkLineStyle))
  })
  const radius = map.getZoom() >= 15 ? 4 : map.getZoom() >= 12 ? 2.5 : 1.4
  network.places.forEach((place) => {
    const marker = L.circleMarker([place.latitude, place.longitude], {
      renderer: networkRenderer, radius, weight: 1, color: '#fffaf0', fillColor: '#4f685b', fillOpacity: .72,
    })
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        // 路線規劃進行中,點小站點就是在指定起終點;
        // 不能走 findNearbyPlaces,那條路會把規劃狀態整個清掉
        if (tripStage !== 'idle') {
          void selectTripCoordinate(place.latitude, place.longitude)
          return
        }
        void findNearbyPlaces(place.latitude, place.longitude, true)
      })
      .addTo(networkLayer)
    bindHoverTooltip(marker, place.name)
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
  // 只有「選點進行中」需要中止規劃;已有行程結果就保留,
  // 點站牌不再把整趟規劃清掉,附近站牌視圖會給「返回行程候選」的退路。
  if (interactionMode === 'trip') clearTripState()
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
  setViewBack(renderRoutePicker)
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
  bindHoverTooltip(origin, '你點的位置')

  for (const place of lastNearbyPlaces) {
    bindHoverTooltip(unifiedStopMarker([place.latitude, place.longitude], true), `${place.name} · ${Math.round(place.distanceMeters)} m`)
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
  const nearbyBack = hasTripResults() ? returnToTripResults : renderRoutePicker
  drawer.replaceChildren(
    drawerBack(hasTripResults() ? '返回行程候選' : '路線列表', nearbyBack),
    heading('附近站牌', '點任一站牌，就會預覽所有經過路線。'),
    list,
    tripModeButton(),
  )
  setStatus(lastNearbyPlaces.length ? `找到 ${lastNearbyPlaces.length} 個附近站牌` : '附近沒有站牌')
  const [latitude, longitude] = lastNearbyOrigin
  history.replaceState(null, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
  setViewBack(nearbyBack)
}

async function selectTripCoordinate(latitude: number, longitude: number) {
  if (!activeCity) return
  // 連點(桌機雙擊尤其)會發出兩次選點;第二發會在第一發把階段推進之後
  // 才回來,被誤當成目的地。一次只處理一發,其餘直接丟掉。
  if (tripSelecting) return
  tripSelecting = true
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
        drawerBack('取消路線規劃', cancelTripMode),
        heading('再點一下目的地', `出發位置靠近「${nearest.name}」，現在直接點地圖上的目的地。`),
      )
      setStatus(`出發：${nearest.name} · 請點目的地`)
      setViewBack(cancelTripMode)
    } else {
      if (selectedFrom?.placeId === nearest.placeId) throw new Error('出發位置和目的地配對到同一站，請選遠一點')
      selectedTo = nearest
      toCoordinate = [latitude, longitude]
      tripStage = 'idle'
      interactionMode = 'trip-results'
      // 起終點都定了,背景路網功成身退,讓建議路線乾淨登場
      setNetworkVisible(false)
      nearbyLayer.clearLayers()
      drawTripEndpoints()
      await loadDirectRoutes()
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '站牌配對失敗', true)
  } finally {
    tripSelecting = false
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
    // 這時 tripStage 已回 idle(點地圖會變成逛附近站牌),不能把使用者
    // 留在「再點一下目的地」的殘局:給重試,退路則回到重新選目的地。
    const retry = document.createElement('button')
    retry.className = 'quiet-button'
    retry.textContent = '再試一次'
    retry.addEventListener('click', () => void loadDirectRoutes())
    drawer.replaceChildren(
      drawerBack('重新選目的地', resumeDestinationSelection),
      heading('查詢失敗了', `${from.name} → ${to.name} 暫時查不到，稍等一下再試。`),
      retry,
    )
    setViewBack(resumeDestinationSelection)
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
  if (!directRoutes.length) list.appendChild(paragraph('目前沒有找到直達車。'))
  directRoutes.forEach((route) => {
    const color = routeColor(route.routeName)
    const button = document.createElement('button')
    button.className = 'direct-route-button'
    button.style.setProperty('--route-color', color)
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
    button.addEventListener('click', () => void loadRoute(route.routeName, route.variantKey, true, color))
    list.appendChild(button)
  })
  const back = drawerBack('重新選目的地', resumeDestinationSelection)
  const reset = tripModeButton()
  drawer.replaceChildren(
    back,
    heading(`${selectedFrom.name} → ${selectedTo.name}`, directRoutes.length ? `${directRoutes.length} 個直達方向，淡色線為候選路線。` : '沒有直達路線'),
    list,
    reset,
  )
  setStatus(directRoutes.length ? `找到 ${directRoutes.length} 個直達方向` : '沒有直達車')
  setViewBack(resumeDestinationSelection)
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
        ? `轉乘銜接較趕`
        : `約 ${plan.estimatedTotalMinutes} 分`
    title.appendChild(transfer)
    title.appendChild(count)
    if (plan.connectionStatus === 'tight') card.classList.add('connection-tight')
    card.appendChild(title)
    const legColors = transferLegColors(plan.first.routeName, plan.second.routeName)
    ;[plan.first, plan.second].forEach((leg, legIndex) => {
      const color = legColors[legIndex]
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
  setViewBack(resumeDestinationSelection)
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
    drawerBack('取消路線規劃', cancelTripMode),
    heading('重新選目的地', `保留出發站「${selectedFrom?.name ?? ''}」，請再點一次地圖。`),
  )
  setStatus('已保留出發位置 · 請重新點目的地')
  setViewBack(cancelTripMode)
}

async function previewTransferPlans(plans: TransferPlan[]) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const plan = plans[selectedTransferIndex]
  if (!plan) return
  const previewLegColors = transferLegColors(plan.first.routeName, plan.second.routeName)
  const legs = [
    { ...plan.first, color: previewLegColors[0] },
    { ...plan.second, color: previewLegColors[1] },
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
  const previews = await Promise.all(directRoutes.slice(0, 8).map(async (route) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === route.variantKey)
    return variant ? { variant, color: routeColor(route.routeName), route } : null
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
  const previews = await Promise.all(placeRoutes.slice(0, 8).map(async (route) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await fetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === route.variantKey)
    return variant ? { variant, color: routeColor(route.routeName) } : null
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
  const { line, target } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, normalStyle)
  addPreviewStopDots(variant.stops, color, previewLayer)
  bindHoverTooltip(target, `${variant.routeName} · ${variant.label}`, { sticky: true })
  target.on('mouseover', () => {
    line.setStyle({ ...normalStyle, weight: 8, opacity: .9 })
    line.bringToFront()
  })
  target.on('mouseout', () => line.setStyle(normalStyle))
  target.on('click', (event) => {
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
  const { line: fullLine, target: fullLineTarget } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, {
    color, weight: 3.5, opacity: .2, lineCap: 'round', lineJoin: 'round',
  })
  bindHoverTooltip(fullLineTarget, `${variant.routeName} · ${variant.label}`, { sticky: true })
  fullLineTarget.on('click', (event) => {
    L.DomEvent.stopPropagation(event)
    void loadRoute(variant.routeName, variant.variantKey, true, color)
  })

  const board = variant.stops.features.find((stop) => stop.properties.sequence === boardSequence)
  const alight = variant.stops.features.find((stop) => stop.properties.sequence === alightSequence)
  if (!board || !alight) return fullLine

  addPreviewStopDots(variant.stops, color, previewLayer)

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
    bindHoverTooltip(segment, `${variant.routeName} · ${board.properties.stopName} → ${alight.properties.stopName}`, { sticky: true })
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

function placeRouteRank(route: PlaceRoute, frequency: Map<string, number>): number {
  const eta = route.estimateSeconds === null ? 1_000_000 : route.estimateSeconds
  return eta - Math.min(frequency.get(route.routeUid) ?? 0, 5) * 15
}

function directionFavoriteControl(place: NearbyPlace, route: PlaceRoute): HTMLButtonElement {
  const control = document.createElement('button')
  control.className = 'favorite-direction-button'
  const bus: FavoriteBus = {
    city: activeCity?.code,
    routeName: route.routeName,
    routeUid: route.routeUid,
    subRouteUid: route.subRouteUid,
    stopName: route.stopName,
    stopUid: route.stopUid,
    direction: route.direction,
    directionLabel: route.label,
  }
  let selected = activeCity ? isFavoriteDirection(activeCity.code, place.placeId, bus) : false

  const render = () => {
    control.textContent = selected ? '×' : '＋'
    control.title = selected ? '從首頁移除這個方向' : '將這個方向加入首頁'
    control.setAttribute('aria-label', control.title)
    control.classList.toggle('selected', selected)
  }

  control.addEventListener('click', () => {
    if (!activeCity) return
    selected = toggleFavoriteDirection(activeCity.code, place, { ...bus, city: activeCity.code })
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
  setViewBack(renderNearbyPlaces)
  setStatus(`正在讀取 ${place.name} 的路線…`)
  try {
    const response = await fetch(`/api/v1/map/place/${encodeURIComponent(place.placeId)}/arrivals?city=${encodeURIComponent(activeCity.code)}`)
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
    for (const route of sortedRoutes) {
      const row = document.createElement('div')
      row.className = 'place-route-row'
      const button = document.createElement('button')
      button.className = 'place-route-button'
      const color = routeColor(route.routeName)
      row.style.setProperty('--route-color', color)
      const line = document.createElement('span')
      const routeName = document.createElement('strong')
      routeName.textContent = route.routeName
      const direction = document.createElement('span')
      direction.textContent = route.label
      const eta = document.createElement('b')
      eta.className = 'place-route-eta'
      eta.textContent = route.etaLabel
      if (route.source === 'stale-realtime') {
        const freshness = document.createElement('small')
        freshness.className = 'eta-freshness'
        freshness.textContent = '稍早'
        eta.appendChild(freshness)
      }
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
