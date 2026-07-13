import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { routeLoadingBack, routeViewBack, type RouteBackTarget } from '../../src/domain/map/route-back'
import { createViewBackController } from '../../src/domain/map/view-back'
import { getJourneySegmentCoordinates } from '../../src/domain/map/journey-segment'
import { selectDirectPreviewEntries } from '../../src/domain/map/direct-preview'
import { getTripSelectionConflict, type TripSelectionKind } from '../../src/domain/map/trip-selection'
import { createNavRequestCoordinator } from '../../src/domain/map/nav-request'
import { buildNetworkIndex, pickNetwork, type LonLat, type NetworkIndex } from '../../src/domain/map/network-pick'
import { captureMapCamera, restoreMapCamera, type MapCameraState } from '../../src/domain/map/journey-camera'
import {
  describeTransferEstimate,
  estimateTransfer,
  transferEstimateSortKey,
  type TransferEstimate,
} from '../../src/domain/map/transfer-estimate'
import {
  getActiveCity,
  isFavoriteDirection,
  readBoards,
  setActiveCity,
  tdxHeaders,
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
  labelOffset?: [number, number]
}

type RouteItem = {
  routeName: string
  category: string
}

type RouteMapVariant = {
  variantKey: string
  routeName: string
  routeUid: string
  subRouteUid?: string
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

type JourneyLegPreviewOptions = {
  selected?: boolean
  onSelect?: () => void
}

type JourneyPreviewOptions = {
  fitCamera: boolean
}

type PendingTripSelection = {
  kind: TripSelectionKind
  coordinate: [number, number]
  candidates: NearbyPlace[]
  selected: NearbyPlace
}

type NearbyPlace = {
  placeId: string
  name: string
  latitude: number
  longitude: number
  distanceMeters: number
}

type SearchPlace = Omit<NearbyPlace, 'distanceMeters'>

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
  transferEstimate?: TransferEstimate
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
  { code: 'central', name: '中部', center: [23.95, 120.62], zoom: 8 },
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

// 手機返回鍵的單一哨兵邏輯抽在 view-back.ts(有測試);這裡只注入 history 操作。
const viewBack = createViewBackController({
  push: () => history.pushState({ mochi: true }, '', location.href),
  back: () => history.back(),
  // 被吃掉的哨兵底下那筆網址可能還停在舊畫面(例如 deep link),校正回根層網址。
  onRootReturn: () => history.replaceState(null, '', '/map'),
})

function setViewBack(back?: () => void) {
  viewBack.set(back)
}

window.addEventListener('popstate', () => viewBack.handlePop())

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
// hover 高亮線疊在全路網淡線之上、預覽線之下;獨立 pane 讓它拿到自己的
// renderer(SVG),重繪高亮不會連帶重畫整張全路網 canvas。
map.createPane('networkHoverPane').style.zIndex = '415'
map.createPane('vehiclePane').style.zIndex = '520'

// 全路網一次畫數百條線與站點,效能上仍用 canvas;
// networkPane 在所有互動 pane 之下,canvas 攔截不會影響其他圖層。
// 整層 non-interactive:Leaflet canvas 對每次 mousemove 逐一 hit-test
// 上百條線會讓桌機 hover 卡死,命中改由 network-pick 的網格索引回答。
const networkRenderer = L.canvas({ pane: 'networkPane' })

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
// 行程候選離開前的鏡頭只存可序列化值;路線 detail 的 fit 不應覆蓋它。
let tripResultsCamera: MapCameraState | undefined
let tripResultsCameraCity: string | undefined
// 城市/路線/路網/附近站牌/地點/行程結果是互斥的 drawer 主視圖,各自的
// fetch 都可能被使用者的下一個動作超車;用共用 coordinator 讓「慢的舊回應」
// 安靜作廢,不覆蓋 store、DOM、URL,也不彈錯誤(詳見 nav-request.ts)。
const navRequests = createNavRequestCoordinator()
function beginNavRequest(): { requestId: number; signal: AbortSignal } {
  return navRequests.begin()
}
function isStaleNav(requestId: number): boolean {
  return navRequests.isStale(requestId)
}
let selectedTransferIndex = 0
let selectedDirectIndex = 0
let pendingFromSelection: PendingTripSelection | undefined
let pendingToSelection: PendingTripSelection | undefined
let routeBackAction: (() => void) | undefined
// 經過支線選擇進來的路線,「更換」要退回支線選擇(一層),不能直接跳回路線列表(兩層)。
let lastVariantChoices: { routeName: string; variants: RouteMapVariant[] } | undefined
let variantPickerUsed = false
let networkVisible = false
let networkCache: { city: string; data: CityNetwork; index: NetworkIndex } | undefined
let networkStopMarkers: L.CircleMarker[] = []
let networkHoverLine: LeafletGeoJSON | undefined
let networkHoverRouteIndex = -1
let networkHoverFrame: number | undefined
let networkHoverLatLng: L.LatLng | undefined
let vehicleRefreshTimer: number | undefined

const routePalette = ['#b85f49', '#4f685b', '#55718a', '#b08a47', '#765b78', '#6f7561']
const TRIP_NEARBY_CANDIDATE_LIMIT = 5
const TRIP_NEARBY_FAR_DISTANCE_METERS = 250

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
  // 全路網圖層是 non-interactive,點線/點站點都會落到這裡:先問網格索引。
  // 觸控沒有游標精準度,容差比照舊 canvas tolerance 放大。
  const pick = pickNetworkAt(event.latlng, hoverCapable ? 8 : 14, hoverCapable ? 10 : 16)
  if (tripStage !== 'idle') {
    // 規劃選點中,點到小站點就吸附站點座標;點到線只是瞄準地圖,照點的位置處理
    if (pick?.kind === 'place') void selectTripCoordinate(pick.place.latitude, pick.place.longitude)
    else void selectTripCoordinate(event.latlng.lat, event.latlng.lng)
    return
  }
  if (pick?.kind === 'place') {
    void findNearbyPlaces(pick.place.latitude, pick.place.longitude, true)
    return
  }
  if (pick?.kind === 'route') {
    void loadRoute(pick.route.routeName, pick.route.variantKey, false, routeColor(pick.route.routeName))
    return
  }
  if (map.getZoom() >= 14) void findNearbyPlaces(event.latlng.lat, event.latlng.lng, true)
  else {
    map.flyTo(event.latlng, 14)
    setStatus('放大後再選站牌，避免誤選太遠的位置')
  }
})

function showTaiwan() {
  stopVehicleRefresh()
  beginNavRequest()
  clearPendingTripSelections()
  clearTripResultsCamera()
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
  selectedDirectIndex = 0
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
  setDocumentTitle()
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
    setStatus(`猜你在${nearest.name}，猜錯按「返回縣市」重選。`)
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

const CITY_ICON_SIZE: [number, number] = [60, 30]

// 幾組「市被縣包住」的縣市中心點物理距離很近(新竹市／縣、嘉義市／縣、雙北),
// 區域總覽的縮放層級下按鈕會疊在一起;用 labelOffset 只挪動視覺位置,
// 實際點擊/地理定位仍用 city.center,不影響選中的城市。
function cityIconAnchor(city: MapCity): [number, number] {
  const [dx, dy] = city.labelOffset ?? [0, 0]
  return [CITY_ICON_SIZE[0] / 2 - dx, CITY_ICON_SIZE[1] / 2 - dy]
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
  clearPendingTripSelections()
  clearTripResultsCamera()
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
        iconSize: CITY_ICON_SIZE,
        iconAnchor: cityIconAnchor(city),
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
  clearPendingTripSelections()
  clearTripResultsCamera()
  activeCity = city
  setActiveCity(city.code)
  const { requestId, signal } = beginNavRequest()
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
  selectedDirectIndex = 0
  map.setView(city.center, 11)
  setDocumentTitle(`${city.name}公車地圖`)
  setStatus(`${city.name} · 正在整理路線…`)
  drawer.replaceChildren(drawerBack('返回區域', () => showRegion(city.region)), heading(city.name, '正在載入路線…'))
  setViewBack(() => showRegion(city.region))

  try {
    const response = await tdxFetch(`/api/v1/map/routes?city=${encodeURIComponent(city.code)}`, { signal })
    const data = await response.json() as { routes?: RouteItem[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    if (isStaleNav(requestId)) return
    routes = data.routes
    routesCityCode = city.code
    category = '全部'
    renderRoutePicker()
    setStatus(`${city.name} · ${routes.length} 條路線`)
  } catch {
    if (isStaleNav(requestId)) return
    setStatus('目前無法載入這個縣市的路線。', true)
    drawer.replaceChildren(
      drawerBack('返回區域', () => showRegion(city.region)),
      heading(city.name, '目前無法載入這個縣市的路線。'),
      retryButton(() => void chooseCity(city)),
    )
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
        const response = await tdxFetch(`/api/v1/map/routes?city=${encodeURIComponent(cityCode)}`)
        const data = await response.json() as { routes?: RouteItem[]; error?: string }
        if (!response.ok || !data.routes) throw new Error(data.error)
        routes = data.routes
        routesCityCode = cityCode
        category = '全部'
        // 載回來時使用者可能已經離開選單(開了路線、換了城市),別把畫面搶回來
        if (interactionMode === 'browse' && activeCity?.code === cityCode) renderRoutePicker()
      } catch {
        // 同樣不能把失敗畫面搶回使用者已經離開的城市/選單
        if (interactionMode !== 'browse' || activeCity?.code !== cityCode) return
        setStatus('目前無法載入這個縣市的路線。', true)
        drawer.replaceChildren(
          drawerBack('返回縣市', () => showRegion(activeCity!.region)),
          heading(activeCity!.name, '目前無法載入這個縣市的路線。'),
          retryButton(() => renderRoutePicker()),
        )
      }
    })()
    return
  }
  const back = drawerBack('返回縣市', () => showRegion(activeCity!.region))
  const title = heading(activeCity.name, '不用設定起終點，直接看一條公車。')
  const search = document.createElement('input')
  search.className = 'map-search'
  search.placeholder = '篩選路線，或搜尋站牌名稱'
  search.setAttribute('aria-label', '篩選路線，或搜尋站牌名稱')
  const categories = document.createElement('div')
  categories.className = 'map-categories'
  const stopResults = document.createElement('div')
  stopResults.className = 'place-search-results'
  const routeGrid = document.createElement('div')
  routeGrid.className = 'map-route-grid'

  const counts = new Map<string, number>()
  routes.forEach((route) => counts.set(route.category, (counts.get(route.category) ?? 0) + 1))
  const names = ['全部', ...['數字', '幹線', '接駁', '幸福／社區', '觀光', '小黃', '公路客運', '其他'].filter((name) => counts.has(name))]

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
  // 同一個輸入框兼作站牌搜尋:2 個字以上就順便查站牌,結果排在路線格之上。
  let stopSearchTimer: number | undefined
  const queueStopSearch = () => {
    window.clearTimeout(stopSearchTimer)
    const query = search.value.trim()
    if (query.length < 2) {
      stopResults.replaceChildren()
      return
    }
    stopSearchTimer = window.setTimeout(() => {
      void (async () => {
        const places = await searchPlaces(query)
        if (search.value.trim() !== query) return
        stopResults.replaceChildren(...places.slice(0, 6).map((place) => searchResultButton(place, openSearchedPlace)))
      })()
    }, 300)
  }
  search.addEventListener('input', () => {
    render()
    queueStopSearch()
  })
  drawer.replaceChildren(back, title, tripModeButton(), search, categories, stopResults, routeGrid)
  render()
  setViewBack(() => { if (activeCity) showRegion(activeCity.region) })
}

// 會落到 TDX 即時查詢的端點(到站、車輛、行程 ETA、路線的 TDX fallback)
// 帶上使用者自備的憑證;純快照端點(D1/R2)用一般 fetch 就好。
function tdxFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: { ...(init?.headers as Record<string, string> | undefined), ...tdxHeaders() },
  })
}

async function searchPlaces(query: string): Promise<SearchPlace[]> {
  if (!activeCity) return []
  const params = new URLSearchParams({ city: activeCity.code, q: query })
  const response = await fetch(`/api/v1/map/search?${params}`)
  if (!response.ok) return []
  const data = await response.json() as { places?: SearchPlace[] }
  return data.places ?? []
}

function searchResultButton(place: SearchPlace, onPick: (place: SearchPlace) => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'nearby-place-button'
  const name = document.createElement('strong')
  name.textContent = place.name
  const kind = document.createElement('span')
  kind.textContent = '站牌'
  button.appendChild(name)
  button.appendChild(kind)
  button.addEventListener('click', () => onPick(place))
  return button
}

function pendingTripSelection(kind: TripSelectionKind): PendingTripSelection | undefined {
  return kind === 'from' ? pendingFromSelection : pendingToSelection
}

function setPendingTripSelection(selection: PendingTripSelection) {
  if (selection.kind === 'from') pendingFromSelection = selection
  else pendingToSelection = selection
}

function clearPendingTripSelection(kind: TripSelectionKind) {
  if (kind === 'from') pendingFromSelection = undefined
  else pendingToSelection = undefined
}

function clearPendingTripSelections() {
  pendingFromSelection = undefined
  pendingToSelection = undefined
}

function tripSelectionConflict(kind: TripSelectionKind, candidate: NearbyPlace): string | undefined {
  return getTripSelectionConflict(kind, candidate, selectedFrom, selectedTo)
}

function formatTripDistance(distanceMeters: number): string {
  return `${Math.round(distanceMeters)} m`
}

function tripDistanceWarning(distanceMeters: number): HTMLSpanElement | undefined {
  if (distanceMeters <= TRIP_NEARBY_FAR_DISTANCE_METERS) return undefined
  const warning = document.createElement('span')
  warning.className = 'trip-distance-warning'
  warning.textContent = '站牌離點選位置稍遠'
  return warning
}

function tripMatchedSummary(kind: TripSelectionKind): HTMLElement | undefined {
  const pending = pendingTripSelection(kind)
  if (!pending) return
  const summary = document.createElement('div')
  summary.className = 'trip-matched-summary'
  const copy = document.createElement('p')
  copy.textContent = `已配對：${pending.selected.name} · 距離點選位置 ${formatTripDistance(pending.selected.distanceMeters)}`
  summary.appendChild(copy)
  const warning = tripDistanceWarning(pending.selected.distanceMeters)
  if (warning) summary.appendChild(warning)
  const change = document.createElement('button')
  change.type = 'button'
  change.className = 'trip-nearby-change'
  change.textContent = '改選附近站牌'
  change.addEventListener('click', () => renderPendingTripCandidates(kind))
  summary.appendChild(change)
  return summary
}

function tripMatchedControls(): HTMLElement | undefined {
  const from = tripMatchedSummary('from')
  const to = tripMatchedSummary('to')
  if (!from && !to) return
  const controls = document.createElement('div')
  controls.className = 'trip-matched-controls'
  if (from) controls.appendChild(from)
  if (to) controls.appendChild(to)
  return controls
}

function renderPendingTripCandidates(kind: TripSelectionKind) {
  const pending = pendingTripSelection(kind)
  if (!pending) {
    renderTripSelectionStep(kind)
    return
  }
  const list = document.createElement('div')
  list.className = 'trip-nearby-candidate-list'
  pending.candidates.forEach((candidate) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'trip-nearby-candidate'
    const selected = candidate.placeId === pending.selected.placeId
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-pressed', String(selected))
    const name = document.createElement('strong')
    name.textContent = candidate.name
    const distance = document.createElement('span')
    distance.textContent = formatTripDistance(candidate.distanceMeters)
    button.appendChild(name)
    button.appendChild(distance)
    const warning = tripDistanceWarning(candidate.distanceMeters)
    if (warning) button.appendChild(warning)
    button.addEventListener('click', () => void selectTripCandidate(kind, candidate))
    list.appendChild(button)
  })
  const backAction = hasTripResults() ? returnToTripResults : () => renderTripSelectionStep(kind)
  drawer.replaceChildren(
    drawerBack(hasTripResults() ? '返回行程候選' : '返回選點', backAction),
    heading('改選附近站牌', '保留原本點擊位置，選一個更符合道路另一側或同名站位的站牌。'),
    list,
  )
  setStatus(`${kind === 'from' ? '出發' : '目的地'}附近有 ${pending.candidates.length} 個候選站牌`)
  setViewBack(backAction)
}

function renderTripSelectionStep(nextKind: TripSelectionKind) {
  tripStage = nextKind
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  drawTripEndpoints()
  const existingKind: TripSelectionKind = nextKind === 'from' ? 'to' : 'from'
  const existing = existingKind === 'from' ? selectedFrom : selectedTo
  const existingSummary = tripMatchedSummary(existingKind)
  const explicitSummary = existing && !existingSummary ? paragraph(`已選擇：${existing.name}`) : undefined
  const searchLabel = nextKind === 'from' ? '搜尋出發站牌' : '搜尋目的地站牌'
  const title = nextKind === 'from' ? '點一下出發位置' : '再點一下目的地'
  const description = nextKind === 'from'
    ? '直接點地圖配對最近站牌，或輸入站牌名稱。'
    : `出發位置靠近「${selectedFrom?.name ?? ''}」，點地圖上的目的地或輸入站牌名稱。`
  drawer.replaceChildren(
    drawerBack('取消路線規劃', cancelTripMode),
    heading(title, description),
    existingSummary ?? explicitSummary ?? document.createDocumentFragment(),
    placeSearchBox(searchLabel, (place) => void selectTripPlace(nextKind, place)),
  )
  setStatus(nextKind === 'from' ? '路線規劃 · 請點出發位置' : `出發：${selectedFrom?.name ?? ''} · 請點目的地`)
  setViewBack(cancelTripMode)
}

async function applyTripSelection(
  kind: TripSelectionKind,
  candidate: NearbyPlace,
  coordinate: [number, number],
): Promise<boolean> {
  const conflict = tripSelectionConflict(kind, candidate)
  if (conflict) {
    setStatus(conflict, true)
    return false
  }
  const pending = pendingTripSelection(kind)
  if (pending) pending.selected = candidate
  if (kind === 'from') {
    selectedFrom = candidate
    fromCoordinate = coordinate
  } else {
    selectedTo = candidate
    toCoordinate = coordinate
  }
  if (selectedFrom && selectedTo) {
    tripStage = 'idle'
    interactionMode = 'trip-results'
    lastDirectRoutes = []
    lastTransferPlans = []
    setNetworkVisible(false)
    nearbyLayer.clearLayers()
    drawTripEndpoints()
    await loadDirectRoutes()
    return true
  }
  renderTripSelectionStep(kind === 'from' ? 'to' : 'from')
  return true
}

async function selectTripCandidate(kind: TripSelectionKind, candidate: NearbyPlace) {
  const pending = pendingTripSelection(kind)
  if (!pending) return
  await applyTripSelection(kind, candidate, pending.coordinate)
}

async function selectTripPlace(kind: TripSelectionKind, place: SearchPlace) {
  clearPendingTripSelection(kind)
  const candidate: NearbyPlace = { ...place, distanceMeters: 0 }
  await applyTripSelection(kind, candidate, [place.latitude, place.longitude])
}

// 站牌名稱搜尋框:輸入 2 個字以上就打 /api/v1/map/search,
// 讓不熟地圖的人(或外地人)不用在地圖上大海撈針。
function placeSearchBox(placeholder: string, onPick: (place: SearchPlace) => void): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'place-search'
  const input = document.createElement('input')
  input.className = 'map-search'
  input.placeholder = placeholder
  input.setAttribute('aria-label', placeholder)
  const results = document.createElement('div')
  results.className = 'place-search-results'
  let timer: number | undefined
  input.addEventListener('input', () => {
    window.clearTimeout(timer)
    const query = input.value.trim()
    if (query.length < 2) {
      results.replaceChildren()
      return
    }
    timer = window.setTimeout(() => {
      void (async () => {
        const places = await searchPlaces(query)
        // 回來時使用者可能又改了字,只渲染還是最新查詢的結果
        if (input.value.trim() !== query) return
        if (!places.length) {
          results.replaceChildren(paragraph('找不到這個站牌，換個關鍵字試試。'))
          return
        }
        results.replaceChildren(...places.slice(0, 6).map((place) => searchResultButton(place, onPick)))
      })()
    }, 300)
  })
  wrap.appendChild(input)
  wrap.appendChild(results)
  return wrap
}

// 搜尋選中的站牌直接開站牌路線視圖(跟 deep link 進站牌同一條路)。
function openSearchedPlace(place: SearchPlace) {
  map.setView([place.latitude, place.longitude], 16)
  const nearbyPlace: NearbyPlace = { ...place, distanceMeters: 0 }
  lastNearbyOrigin = [place.latitude, place.longitude]
  lastNearbyPlaces = [nearbyPlace]
  interactionMode = 'nearby'
  void showPlaceRoutes(nearbyPlace)
}

function tripModeButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'trip-mode-button'
  button.textContent = '↗'
  button.title = '路線規劃'
  button.setAttribute('aria-label', '路線規劃：選擇出發位置與目的地')
  button.addEventListener('click', () => {
    clearTripResultsCamera()
    clearPendingTripSelections()
    selectedFrom = undefined
    selectedTo = undefined
    fromCoordinate = undefined
    toCoordinate = undefined
    lastDirectRoutes = []
    lastTransferPlans = []
    selectedDirectIndex = 0
    tripStage = 'from'
    interactionMode = 'trip'
    // 全路網開著就留著:小站點正好當選點的瞄準參考,等終點選完才收
    previewLayer.clearLayers()
    routeLayer.clearLayers()
    nearbyLayer.clearLayers()
    renderTripSelectionStep('from')
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
  selectedDirectIndex = 0
  clearPendingTripSelections()
  clearTripResultsCamera()
}

function captureTripResultsCamera() {
  if (!activeCity || !hasTripResults()) return
  tripResultsCamera = captureMapCamera(map)
  tripResultsCameraCity = activeCity.code
}

function restoreTripResultsCamera(): boolean {
  if (!activeCity || !tripResultsCamera || tripResultsCameraCity !== activeCity.code || !hasTripResults()) return false
  restoreMapCamera(map, tripResultsCamera)
  return true
}

function clearTripResultsCamera() {
  tripResultsCamera = undefined
  tripResultsCameraCity = undefined
  // 清除行程也要讓尚未完成的 preview 失效,避免舊回應重新畫線或 fit。
  previewRequest += 1
}

function normalizeDirectIndex(directRoutes: DirectRoute[]): number {
  if (!directRoutes.length) return 0
  return Math.min(Math.max(selectedDirectIndex, 0), directRoutes.length - 1)
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
  void (async () => {
    if (lastDirectRoutes.length) renderDirectRoutes(lastDirectRoutes)
    else renderTransferPlans(lastTransferPlans)
    let previewCompleted = false
    try {
      previewCompleted = lastDirectRoutes.length
        ? await previewDirectRoutes(lastDirectRoutes, { fitCamera: false })
        : await previewTransferPlans(lastTransferPlans, { fitCamera: false })
    } catch {
      // 預覽資料失敗時仍保留候選抽屜與離開前鏡頭,不讓錯誤的 fallback fit 搶走視角。
      if (hasTripResults()) {
        drawTripEndpoints()
        restoreTripResultsCamera()
      }
      return
    }
    if (!previewCompleted || !hasTripResults()) return
    drawTripEndpoints()
    restoreTripResultsCamera()
  })()
}

// 把 route-back.ts 的純決策目標對應回實際的導航動作。
function backActionFor(target: RouteBackTarget): () => void {
  if (target === 'trip-results') return returnToTripResults
  if (target === 'variant-picker') {
    return () => {
      if (lastVariantChoices) {
        renderVariantPicker(lastVariantChoices.routeName, lastVariantChoices.variants)
        setStatus(`${lastVariantChoices.routeName} · 選擇行駛方向`)
      } else {
        renderRoutePicker()
      }
    }
  }
  if (target === 'stop-view') return () => (routeBackAction ?? renderRoutePicker)()
  return renderRoutePicker
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

function openTripRoute(
  routeName: string,
  preferredVariant: string | null | undefined,
  color: string,
  backAction?: () => void,
) {
  captureTripResultsCamera()
  void loadRoute(routeName, preferredVariant, true, color, backAction)
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
  previewRequest += 1
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  if (!returnToTrip && !hasTripResults()) clearTripState()
  // 載入中(和載入失敗時)的返回也要指對地方:從行程候選進來的,
  // 退路是候選清單;指到 renderRoutePicker 會把整趟規劃清掉。
  const loading = routeLoadingBack({ returnToTrip, hasStopBackAction: Boolean(backAction) })
  const loadingBack = backActionFor(loading.target)
  const { requestId, signal } = beginNavRequest()
  setStatus(`${routeName} · 正在讀取城市裡的路徑…`)
  drawer.replaceChildren(drawerBack(loading.label, loadingBack), heading(routeName, '正在拼起路線與站牌…'))
  setViewBack(loadingBack)
  try {
    const params = new URLSearchParams({ city: activeCity.code, route: routeName })
    const response = await tdxFetch(`/api/v1/map/route?${params}`, { signal })
    const data = await response.json() as { variants?: RouteMapVariant[]; error?: string }
    if (!response.ok || !data.variants?.length) throw new Error(data.error)
    if (isStaleNav(requestId)) return
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
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '目前無法取得這條路線。'
    setStatus(message, true)
    drawer.replaceChildren(
      drawerBack(loading.label, loadingBack),
      heading(routeName, message),
      retryButton(() => void loadRoute(routeName, preferredVariant, returnToTrip, color, backAction)),
    )
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
  const decision = routeLoadingBack({ returnToTrip: routeReturnsToTrip, hasStopBackAction: Boolean(routeBackAction) })
  const variantBack = backActionFor(decision.target)
  drawer.replaceChildren(
    drawerBack(decision.label, variantBack),
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
  const backContext = () => ({
    returnToTrip: routeReturnsToTrip,
    hasTripResults: hasTripResults(),
    canReturnToVariantPicker,
    hasStopBackAction: Boolean(routeBackAction),
  })
  change.textContent = routeViewBack(backContext()).label
  // 目標在按下時才決定:行程候選可能在停留期間被丟棄,要退到降級後的那一層。
  const goBack = () => backActionFor(routeViewBack(backContext()).target)()
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
  setDocumentTitle(`${variant.routeName} 公車路線圖`)
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
      const response = await tdxFetch(`/api/v1/map/vehicles?${params}`, { cache: 'no-store' })
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
  const { requestId, signal } = beginNavRequest()
  setStatus('正在展開整個城市路網…')
  try {
    if (!networkCache || networkCache.city !== activeCity.code) {
      const response = await fetch(`/api/v1/map/network?city=${encodeURIComponent(activeCity.code)}`, { signal })
      const data = await response.json() as CityNetwork & { error?: string }
      if (!response.ok) throw new Error(data.error)
      // 圖層全部 non-interactive,hover/click 的命中由網格索引回答;跟資料一起快取
      const index = buildNetworkIndex(
        data.routes.map((route) => route.shape.geometry.coordinates as LonLat[]),
        data.places.map((place) => [place.longitude, place.latitude] as LonLat),
      )
      networkCache = { city: activeCity.code, data, index }
    }
    if (isStaleNav(requestId)) return
    drawCityNetwork(networkCache.data)
    setStatus(`全路網 · ${networkCache.data.routes.length} 個方向 · ${networkCache.data.places.length} 個站點`)
  } catch (error) {
    if (isStaleNav(requestId)) return
    setStatus(error instanceof Error && error.message ? error.message : '全路網讀取失敗', true)
  }
}

function drawCityNetwork(network: CityNetwork) {
  stopVehicleRefresh()
  routeLayer.clearLayers()
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  networkLayer.clearLayers()
  clearNetworkHover()
  networkStopMarkers = []
  // 淡線是刻意的:全路網數百條線只當背景,站點與 hover 強調才是主角。
  // 整層 non-interactive:canvas 對互動 path 每次 mousemove 都要逐條 hit-test,
  // 桌機 hover 會卡死;hover/click 改由地圖層級事件 + 網格索引接手。
  const networkLineStyle = { weight: 2.6, opacity: .34, lineCap: 'round' as const, lineJoin: 'round' as const }
  network.routes.forEach((route) => {
    L.geoJSON(route.shape, {
      // renderer/interactive 屬於 PathOptions,經 style 併入 layer options,在加入地圖前生效。
      style: { renderer: networkRenderer, color: routeColor(route.routeName), interactive: false, ...networkLineStyle },
    }).addTo(networkLayer)
  })
  const radius = map.getZoom() >= 15 ? 4 : map.getZoom() >= 12 ? 2.5 : 1.4
  network.places.forEach((place) => {
    const marker = L.circleMarker([place.latitude, place.longitude], {
      renderer: networkRenderer, interactive: false, radius, weight: 1, color: '#fffaf0', fillColor: '#4f685b', fillOpacity: .72,
    }).addTo(networkLayer)
    networkStopMarkers.push(marker)
  })
  networkVisible = true
  networkButton.classList.add('active')
  networkButton.setAttribute('aria-pressed', 'true')
}

function setNetworkVisible(visible: boolean) {
  if (visible) return
  clearNetworkHover()
  networkLayer.clearLayers()
  networkStopMarkers = []
  networkVisible = false
  networkButton.classList.remove('active')
  networkButton.setAttribute('aria-pressed', 'false')
}

// 把游標下的位置丟給網格索引,容差以像素給、在這裡換算成緯度度數;
// 回傳直接解好參照的路線/站點,呼叫端不用碰索引細節。
type ResolvedNetworkPick =
  | { kind: 'place'; place: CityNetwork['places'][number] }
  | { kind: 'route'; route: CityNetwork['routes'][number]; routeIndex: number }

function pickNetworkAt(latlng: L.LatLng, routePixels: number, placePixels: number): ResolvedNetworkPick | undefined {
  if (!networkVisible || !networkCache) return undefined
  const pick = pickNetwork(
    networkCache.index,
    [latlng.lng, latlng.lat],
    pixelsToLatDegrees(routePixels),
    pixelsToLatDegrees(placePixels),
  )
  if (!pick) return undefined
  if (pick.kind === 'place') return { kind: 'place', place: networkCache.data.places[pick.placeIndex] }
  return { kind: 'route', route: networkCache.data.routes[pick.routeIndex], routeIndex: pick.routeIndex }
}

// 用地圖自己的投影換算「n 像素在目前 zoom 是幾度緯度」,不用自己背公式。
function pixelsToLatDegrees(pixels: number): number {
  const size = map.getSize()
  const center = map.containerPointToLatLng([size.x / 2, size.y / 2])
  const shifted = map.containerPointToLatLng([size.x / 2, size.y / 2 - pixels])
  return Math.abs(shifted.lat - center.lat)
}

// 全路網共用一顆 tooltip、一條高亮線:數千個圖形各綁 tooltip/事件的成本
// 才是桌機卡頓的來源。高亮線畫在 networkHoverPane(自己的 SVG renderer),
// 重繪它不會連帶重畫整張全路網 canvas。
const networkHoverTooltip = L.tooltip({ direction: 'top', offset: [0, -10] })

map.on('mousemove', (event) => {
  if (!hoverCapable || !networkVisible) return
  networkHoverLatLng = event.latlng
  if (networkHoverFrame !== undefined) return
  networkHoverFrame = requestAnimationFrame(() => {
    networkHoverFrame = undefined
    if (networkHoverLatLng) updateNetworkHover(networkHoverLatLng)
  })
})
// 拖曳/縮放中游標下的東西一直在變,乾脆收掉;滑出地圖容器也是。
map.on('movestart', clearNetworkHover)
map.on('mouseout', clearNetworkHover)

function updateNetworkHover(latlng: L.LatLng) {
  const pick = pickNetworkAt(latlng, 6, 9)
  if (!pick) {
    clearNetworkHover()
    return
  }
  map.getContainer().style.cursor = 'pointer'
  if (pick.kind === 'place') {
    setNetworkHighlight(-1)
    networkHoverTooltip.setContent(pick.place.name).setLatLng([pick.place.latitude, pick.place.longitude])
  } else {
    setNetworkHighlight(pick.routeIndex)
    networkHoverTooltip.setContent(`${pick.route.routeName} · ${pick.route.label}`).setLatLng(latlng)
  }
  if (!map.hasLayer(networkHoverTooltip)) networkHoverTooltip.openOn(map)
}

function setNetworkHighlight(routeIndex: number) {
  if (routeIndex === networkHoverRouteIndex) return
  networkHoverLine?.remove()
  networkHoverLine = undefined
  networkHoverRouteIndex = routeIndex
  if (routeIndex < 0 || !networkCache) return
  const route = networkCache.data.routes[routeIndex]
  networkHoverLine = L.geoJSON(route.shape, {
    pane: 'networkHoverPane',
    style: {
      color: routeColor(route.routeName), weight: 5, opacity: .75,
      lineCap: 'round', lineJoin: 'round', interactive: false,
    },
  }).addTo(map)
}

function clearNetworkHover() {
  setNetworkHighlight(-1)
  // 排隊中的 rAF 醒來會看到 undefined,不會把剛清掉的 hover 又補回來
  networkHoverLatLng = undefined
  if (map.hasLayer(networkHoverTooltip)) map.closeTooltip(networkHoverTooltip)
  map.getContainer().style.cursor = ''
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
  const { requestId, signal } = beginNavRequest()

  try {
    const params = new URLSearchParams({
      city: city.code,
      lat: String(latitude),
      lon: String(longitude),
      radius: String(radius),
    })
    const response = await fetch(`/api/v1/map/nearby?${params}`, { signal })
    const data = await response.json() as { places?: NearbyPlace[]; error?: string }
    if (!response.ok || !data.places) throw new Error(data.error)
    if (isStaleNav(requestId)) return
    lastNearbyPlaces = data.places.slice(0, 12)
    renderNearbyPlaces()
    if (autoPreview && lastNearbyPlaces[0]) await showPlaceRoutes(lastNearbyPlaces[0])
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '附近站牌讀取失敗'
    setStatus(message, true)
    drawer.replaceChildren(
      drawerBack('附近站牌', renderNearbyPlaces),
      heading('附近站牌讀取失敗', message),
      retryButton(() => void findNearbyPlaces(latitude, longitude, autoPreview)),
    )
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
  setDocumentTitle(`${activeCity.name}公車地圖`)
  setViewBack(nearbyBack)
}

async function selectTripCoordinate(latitude: number, longitude: number) {
  if (!activeCity) return
  // 連點(桌機雙擊尤其)會發出兩次選點;第二發會在第一發把階段推進之後
  // 才回來,被誤當成目的地。一次只處理一發,其餘直接丟掉。
  if (tripSelecting) return
  const kind = tripStage
  if (kind === 'idle') return
  tripSelecting = true
  clearPendingTripSelection(kind)
  const radius = map.getZoom() >= 15 ? 300 : 500
  const params = new URLSearchParams({ city: activeCity.code, lat: String(latitude), lon: String(longitude), radius: String(radius) })
  setStatus(kind === 'from' ? '正在配對出發位置附近站牌…' : '正在配對目的地附近站牌…')
  try {
    const response = await fetch(`/api/v1/map/nearby?${params}`)
    const data = await response.json() as { places?: NearbyPlace[]; error?: string }
    const candidates = data.places?.slice(0, TRIP_NEARBY_CANDIDATE_LIMIT) ?? []
    const nearest = candidates[0]
    if (!response.ok || !nearest) throw new Error(data.error ?? '這附近沒有站牌')
    setPendingTripSelection({ kind, coordinate: [latitude, longitude], candidates, selected: nearest })
    await applyTripSelection(kind, nearest, [latitude, longitude])
  } catch (error) {
    setStatus(error instanceof Error ? error.message : '站牌配對失敗', true)
  } finally {
    tripSelecting = false
  }
}

async function loadDirectRoutes() {
  if (!activeCity || !selectedFrom || !selectedTo) return
  clearTripResultsCamera()
  const from = selectedFrom
  const to = selectedTo
  const { requestId, signal } = beginNavRequest()
  setStatus(`正在找 ${from.name} → ${to.name} 的直達車…`)
  try {
    const params = new URLSearchParams({ city: activeCity.code, from: from.placeId, to: to.placeId })
    const response = await fetch(`/api/v1/map/direct?${params}`, { signal })
    const data = await response.json() as { routes?: DirectRoute[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    if (isStaleNav(requestId)) return
    if (data.routes.length) {
      const rankedRoutes = await rankDirectRoutesByEta(data.routes)
      if (isStaleNav(requestId)) return
      lastDirectRoutes = rankedRoutes
      lastTransferPlans = []
      selectedDirectIndex = 0
      renderDirectRoutes(rankedRoutes)
      await previewDirectRoutes(rankedRoutes, { fitCamera: true })
      return
    }
    setStatus('沒有直達車，正在找一次轉乘…')
    const transferResponse = await fetch(`/api/v1/map/transfer?${params}`, { signal })
    const transferData = await transferResponse.json() as { plans?: TransferPlan[]; error?: string }
    if (!transferResponse.ok || !transferData.plans) throw new Error(transferData.error)
    if (isStaleNav(requestId)) return
    lastDirectRoutes = []
    selectedDirectIndex = 0
    const rankedPlans = await rankTransferPlansByEta(transferData.plans)
    if (isStaleNav(requestId)) return
    lastTransferPlans = rankedPlans
    selectedTransferIndex = 0
    renderTransferPlans(rankedPlans)
    await previewTransferPlans(rankedPlans, { fitCamera: true })
  } catch (error) {
    if (isStaleNav(requestId)) return
    setStatus(error instanceof Error && error.message ? error.message : '直達路線查詢失敗', true)
    // 這時 tripStage 已回 idle(點地圖會變成逛附近站牌),不能把使用者
    // 留在「再點一下目的地」的殘局:給重試,退路則回到重新選目的地。
    drawer.replaceChildren(
      drawerBack('重新選目的地', resumeDestinationSelection),
      heading('查詢失敗了', `${from.name} → ${to.name} 暫時查不到，稍等一下再試。`),
      retryButton(() => void loadDirectRoutes()),
    )
    setViewBack(resumeDestinationSelection)
  }
}

async function fetchJourneyEta(legs: Array<{ key: string; patternId: string; sequence: number }>) {
  if (!activeCity || !legs.length) return new Map<string, number | null>()
  try {
    const response = await tdxFetch('/api/v1/map/journey-eta', {
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
    const estimate = estimateTransfer({
      firstStopCount: plan.first.stopCount,
      secondStopCount: plan.second.stopCount,
      walkMeters: plan.transferWalkMeters ?? 0,
      firstEtaMinutes: firstEta,
      secondEtaMinutes: secondEta,
    })
    return {
      ...plan,
      firstEtaMinutes: firstEta,
      secondEtaMinutes: secondEta,
      transferEstimate: estimate,
    }
  }).sort((a, b) =>
    transferEstimateSortKey(a.transferEstimate) - transferEstimateSortKey(b.transferEstimate)
    || a.totalStops - b.totalStops,
  )
}

function renderDirectRoutes(directRoutes: DirectRoute[]) {
  if (!selectedFrom || !selectedTo) return
  interactionMode = 'trip-results'
  const selectedIndex = normalizeDirectIndex(directRoutes)
  selectedDirectIndex = selectedIndex
  const list = document.createElement('div')
  list.className = 'direct-route-list'
  if (!directRoutes.length) list.appendChild(paragraph('目前沒有找到直達車。'))
  directRoutes.forEach((route, index) => {
    const color = routeColor(route.routeName)
    const selected = index === selectedIndex
    const card = document.createElement('section')
    card.className = 'direct-route-card'
    card.classList.toggle('selected', selected)
    card.style.setProperty('--route-color', color)
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'direct-route-select'
    button.setAttribute('aria-pressed', String(selected))
    button.setAttribute('aria-label', `${selected ? '目前預覽：' : '選擇：'}${route.routeName} ${route.label}`)
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
    if (selected) {
      const selectedNote = document.createElement('small')
      selectedNote.className = 'direct-route-selected-note'
      selectedNote.textContent = '目前預覽'
      button.appendChild(selectedNote)
    }
    button.addEventListener('click', () => {
      selectedDirectIndex = index
      renderDirectRoutes(directRoutes)
      void previewDirectRoutes(directRoutes, { fitCamera: true })
    })
    const detailButton = document.createElement('button')
    detailButton.type = 'button'
    detailButton.className = 'direct-route-detail'
    detailButton.textContent = '查看完整路線'
    detailButton.setAttribute('aria-label', `查看 ${route.routeName} 完整路線`)
    detailButton.addEventListener('click', (event) => {
      event.stopPropagation()
      openTripRoute(route.routeName, route.variantKey, color)
    })
    card.appendChild(button)
    card.appendChild(detailButton)
    list.appendChild(card)
  })
  const back = drawerBack('重新選目的地', resumeDestinationSelection)
  const reset = tripModeButton()
  const matchedControls = tripMatchedControls()
  drawer.replaceChildren(
    back,
    heading(`${selectedFrom.name} → ${selectedTo.name}`, directRoutes.length ? `${directRoutes.length} 個直達方向，淡色線為候選路線。` : '沒有直達路線'),
    ...(matchedControls ? [matchedControls] : []),
    list,
    changeOriginButton(),
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
      void previewTransferPlans(plans, { fitCamera: true })
    })
    card.addEventListener('keydown', (event) => {
      if (event.target !== event.currentTarget) return
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
    const estimatePresentation = plan.transferEstimate
      ? describeTransferEstimate(plan.transferEstimate)
      : null
    count.textContent = estimatePresentation?.label ?? `共 ${plan.totalStops} 站`
    title.appendChild(transfer)
    title.appendChild(count)
    if (plan.transferEstimate?.connectionStatus === 'tight' || plan.transferEstimate?.connectionStatus === 'missed') {
      card.classList.add('connection-tight')
    }
    card.appendChild(title)
    const assumption = document.createElement('small')
    assumption.className = 'transfer-assumption'
    assumption.textContent = estimatePresentation?.note ?? '未取得足夠資料，請以現場資訊為準'
    card.appendChild(assumption)
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
        openTripRoute(leg.routeName, leg.variantKey, color)
      })
      card.appendChild(button)
    })
    list.appendChild(card)
  })
  const matchedControls = tripMatchedControls()
  drawer.replaceChildren(
    drawerBack('重新選目的地', resumeDestinationSelection),
    heading(`${selectedFrom.name} → ${selectedTo.name}`, plans.length ? `${plans.length} 個一次轉乘方案` : '沒有直達或一次轉乘方案'),
    ...(matchedControls ? [matchedControls] : []),
    list,
    changeOriginButton(),
    tripModeButton(),
  )
  setStatus(plans.length ? `找到 ${plans.length} 個一次轉乘方案` : '沒有合理的一次轉乘方案')
  setViewBack(resumeDestinationSelection)
}

function changeOriginButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'quiet-button change-origin-button'
  button.textContent = '重選出發位置'
  button.addEventListener('click', resumeOriginSelection)
  return button
}

function resumeDestinationSelection() {
  clearTripResultsCamera()
  clearPendingTripSelection('to')
  selectedTo = undefined
  toCoordinate = undefined
  lastDirectRoutes = []
  lastTransferPlans = []
  selectedDirectIndex = 0
  tripStage = 'to'
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  renderTripSelectionStep('to')
}

// 對照 resumeDestinationSelection:保留目的地,只重選出發位置。
// selectTripCoordinate 的 from 分支看到 selectedTo 還在,選完就直接重查。
function resumeOriginSelection() {
  clearTripResultsCamera()
  clearPendingTripSelection('from')
  selectedFrom = undefined
  fromCoordinate = undefined
  lastDirectRoutes = []
  lastTransferPlans = []
  selectedDirectIndex = 0
  tripStage = 'from'
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  renderTripSelectionStep('from')
}

async function previewTransferPlans(plans: TransferPlan[], { fitCamera }: JourneyPreviewOptions): Promise<boolean> {
  if (!activeCity) return false
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const plan = plans[selectedTransferIndex]
  if (!plan) return false
  const previewLegColors = transferLegColors(plan.first.routeName, plan.second.routeName)
  const legs = [
    { ...plan.first, color: previewLegColors[0] },
    { ...plan.second, color: previewLegColors[1] },
  ]
  const previews = await Promise.all(legs.map(async (leg) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: leg.routeName })
    const response = await tdxFetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === leg.variantKey)
    return variant ? { variant, color: leg.color, leg } : null
  }))
  if (requestId !== previewRequest) return false
  const bounds = L.latLngBounds([])
  previews.forEach((preview) => {
    if (!preview) return
    const labels = previews.indexOf(preview) % 2 === 0
      ? ['上車', '轉乘'] as const
      : ['轉乘', '下車'] as const
    const previewLine = addJourneyLegPreview(
      preview.variant,
      preview.color,
      preview.leg.boardSequence,
      preview.leg.alightSequence,
      labels,
      { onSelect: () => openTripRoute(preview.leg.routeName, preview.leg.variantKey, preview.color) },
    )
    bounds.extend(previewLine.focusBounds)
  })
  if (fromCoordinate) bounds.extend(fromCoordinate)
  if (toCoordinate) bounds.extend(toCoordinate)
  if (fitCamera && bounds.isValid()) map.fitBounds(bounds, {
    paddingTopLeft: [45, 90],
    paddingBottomRight: [45, 280],
    maxZoom: 16,
  })
  return true
}

async function previewDirectRoutes(directRoutes: DirectRoute[], { fitCamera }: JourneyPreviewOptions): Promise<boolean> {
  if (!activeCity) return false
  const selectedIndex = normalizeDirectIndex(directRoutes)
  selectedDirectIndex = selectedIndex
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(selectDirectPreviewEntries(directRoutes, selectedIndex).map(async ({ route, index }) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await tdxFetch(`/api/v1/map/route?${params}`)
    if (!response.ok) return null
    const data = await response.json() as { variants?: RouteMapVariant[] }
    const variant = data.variants?.find((item) => item.variantKey === route.variantKey)
    return variant ? { variant, color: routeColor(route.routeName), route, index } : null
  }))
  if (requestId !== previewRequest) return false
  const bounds = L.latLngBounds([])
  let focusBounds: L.LatLngBounds | undefined
  previews.forEach((preview) => {
    if (!preview) return
    const previewLine = addJourneyLegPreview(
      preview.variant,
      preview.color,
      preview.route.boardSequence,
      preview.route.alightSequence,
      ['上車', '下車'],
      {
        selected: preview.index === selectedIndex,
        onSelect: () => {
          selectedDirectIndex = preview.index
          renderDirectRoutes(directRoutes)
          void previewDirectRoutes(directRoutes, { fitCamera: true })
        },
      },
    )
    if (preview.index === selectedIndex && previewLine.hasSegment) focusBounds = previewLine.focusBounds
  })
  if (focusBounds) bounds.extend(focusBounds)
  if (selectedFrom) bounds.extend([selectedFrom.latitude, selectedFrom.longitude])
  if (selectedTo) bounds.extend([selectedTo.latitude, selectedTo.longitude])
  if (fitCamera && bounds.isValid()) map.fitBounds(bounds, {
    paddingTopLeft: [45, 90],
    paddingBottomRight: [45, 280],
    maxZoom: 16,
  })
  return true
}

async function previewPlaceRoutes(placeRoutes: PlaceRoute[], place: NearbyPlace) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(placeRoutes.slice(0, 8).map(async (route) => {
    const params = new URLSearchParams({ city: activeCity!.code, route: route.routeName })
    const response = await tdxFetch(`/api/v1/map/route?${params}`)
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
  options: JourneyLegPreviewOptions = {},
): {
  fullLine: LeafletGeoJSON
  segmentLine?: LeafletGeoJSON
  focusBounds: L.LatLngBounds
  hasSegment: boolean
} {
  const { line: fullLine, target: fullLineTarget } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, {
    color, weight: 3.5, opacity: .2, lineCap: 'round', lineJoin: 'round',
  })
  bindHoverTooltip(fullLineTarget, `${variant.routeName} · ${variant.label}`, { sticky: true })
  fullLineTarget.on('click', (event) => {
    L.DomEvent.stopPropagation(event)
    if (options.onSelect) options.onSelect()
    else openTripRoute(variant.routeName, variant.variantKey, color)
  })

  const board = variant.stops.features.find((stop) => stop.properties.sequence === boardSequence)
  const alight = variant.stops.features.find((stop) => stop.properties.sequence === alightSequence)
  const coordinates = variant.shape.geometry.coordinates as Array<[number, number]>
  const stops = variant.stops.features.map((stop) => ({
    sequence: stop.properties.sequence,
    coordinates: stop.geometry.coordinates as [number, number],
  }))
  const segmentCoordinates = getJourneySegmentCoordinates(coordinates, stops, boardSequence, alightSequence)
  const focusBounds = L.latLngBounds([])
  let segmentLine: LeafletGeoJSON | undefined
  if (segmentCoordinates && board && alight) {
    segmentCoordinates.forEach(([longitude, latitude]) => focusBounds.extend([latitude, longitude]))
    const segmentFeature: GeoJSON.Feature<GeoJSON.LineString> = {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: segmentCoordinates },
    }
    const segment = L.geoJSON(segmentFeature, {
      pane: 'routePreviewPane',
      style: {
        color,
        weight: options.selected === false ? 5 : 7,
        opacity: options.selected === false ? .38 : .92,
        lineCap: 'round',
        lineJoin: 'round',
      },
    }).addTo(previewLayer)
    bindHoverTooltip(segment, `${variant.routeName} · ${board.properties.stopName} → ${alight.properties.stopName}`, { sticky: true })
    segment.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      if (options.onSelect) options.onSelect()
      else openTripRoute(variant.routeName, variant.variantKey, color)
    })
    segmentLine = segment
  }

  if (board) focusBounds.extend([board.geometry.coordinates[1], board.geometry.coordinates[0]])
  if (alight) focusBounds.extend([alight.geometry.coordinates[1], alight.geometry.coordinates[0]])

  if (board && alight) {
    addPreviewStopDots(variant.stops, color, previewLayer)
    ;[[board, labels[0]], [alight, labels[1]]].forEach(([stop, label]) => {
      const feature = stop as typeof board
      const [longitude, latitude] = feature.geometry.coordinates
      unifiedStopMarker([latitude, longitude], true, color)
        .bindTooltip(`${label} · ${feature.properties.stopName}`, { permanent: true, direction: 'top' })
        .addTo(previewLayer)
    })
  }
  return { fullLine, segmentLine, focusBounds, hasSegment: Boolean(segmentLine) }
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
    patternId: route.variantKey,
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
    // 封面只留一個地圖站點:加入時會移除其他站點的地圖收藏,
    // 這件事必須講出來,不能讓使用者之後才發現收藏「憑空消失」。
    const replaced = readBoards().find((board) =>
      board.placeId && !(board.city === activeCity!.code && board.placeId === place.placeId))
    selected = toggleFavoriteDirection(activeCity.code, place, { ...bus, city: activeCity.code })
    render()
    if (selected) {
      setStatus(replaced
        ? `封面改為顯示「${place.name}」，原本的「${replaced.title}」已移除`
        : `已將「${place.name}」的這個方向加入首頁`)
    } else {
      setStatus('已從首頁移除這個方向')
    }
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
  const { requestId, signal } = beginNavRequest()
  try {
    const response = await tdxFetch(`/api/v1/map/place/${encodeURIComponent(place.placeId)}/arrivals?city=${encodeURIComponent(activeCity.code)}`, { signal })
    const data = await response.json() as { routes?: PlaceRoute[]; error?: string }
    if (!response.ok || !data.routes) throw new Error(data.error)
    if (placeRequest !== previewRequest || isStaleNav(requestId)) return
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
      heading(place.name, `${place.distanceMeters > 0 ? `${Math.round(place.distanceMeters)} 公尺 · ` : ''}${data.routes.length} 個行車方向`),
      list,
    )
    await previewPlaceRoutes(sortedRoutes, place)
    if (!activeCity || isStaleNav(requestId)) return
    drawTripEndpoints()
    map.panTo([place.latitude, place.longitude])
    history.replaceState(null, '', `/map?city=${activeCity.code}&place=${encodeURIComponent(place.placeId)}`)
    setDocumentTitle(`${place.name} 到站時間`)
    setStatus(`${place.name} · ${data.routes.length} 個行車方向`)
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '站牌路線讀取失敗'
    setStatus(message, true)
    drawer.replaceChildren(
      drawerBack('附近站牌', renderNearbyPlaces),
      heading(place.name, message),
      retryButton(() => void showPlaceRoutes(place)),
    )
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

// 讀取失敗時的統一退路:skeleton/loading 畫面不能停在原地不動,
// 一定要有明確的錯誤文字加上可以再試一次的按鈕。
function retryButton(onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'quiet-button'
  button.textContent = '再試一次'
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

// 跟著畫面更新分頁標題:多分頁與瀏覽紀錄裡才認得出「哪一條路線、哪一站」。
function setDocumentTitle(prefix?: string) {
  document.title = prefix ? `${prefix}｜Mochi Bus` : '公車地圖｜Mochi Bus'
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}
