import L, { type GeoJSON as LeafletGeoJSON } from 'leaflet'
import { routeLoadingBack, routeViewBack, type RouteBackTarget } from '../../src/domain/map/route-back'
import { getJourneySegmentCoordinates } from '../../src/domain/map/journey-segment'
import { selectDirectPreviewEntries } from '../../src/domain/map/direct-preview'
import { getTripSelectionConflict, type TripSelectionKind } from '../../src/domain/map/trip-selection'
import { createNavRequestCoordinator } from '../../src/domain/map/nav-request'
import { captureMapCamera, restoreMapCamera, type MapCameraState } from '../../src/domain/map/journey-camera'
import {
  describeTransferEstimate,
  estimateTransfer,
  transferEstimateSortKey,
  type TransferEstimate,
} from '../../src/domain/map/transfer-estimate'
import {
  isFavoriteDirection,
  readBoards,
  setActiveCity,
  toggleFavoriteDirection,
  type FavoriteBus,
} from '../boards/store'
import {
  formatJourneyWait,
  splitEtaLabel,
  type EtaSource,
} from '../../src/domain/eta-presentation'
import { tdxWarningMessages } from '../../src/domain/tdx-warning'
import { isTdxTokenRejectedError } from '../tdx/api-client'
import { splitRouteDisplayName } from '../lib/route-display'
import { createMapCameraController } from './camera-controller'
import { createDrawerRenderer, type DrawerView } from './drawer-view'
import { createMapFeatureDiscovery, type MapFeature } from './feature-discovery'
import { createCityNetworkController } from './city-network-controller'
import { bindTextTooltip } from './leaflet-tooltip'
import {
  mapApi,
  type DirectRoute,
  type JourneyEtaEstimate,
  type MapCity,
  type NearbyPlace,
  type PlaceRoute,
  type RegionCode,
  type RouteItem,
  type RouteMapVariant,
  type RouteTimetable,
  type SearchPlace,
  type TimetableStop,
  type TransferPlan,
} from './map-api-client'
import { createTimetablePanel, renderTimetableSummary, timetableSummaryText } from './timetable-view'
import {
  createPlaceSearchBox,
  createPlaceSearchResultButton,
  createReselectTripEndpointButton,
  createTripCandidateList,
  createTripEndpointSummary,
} from './trip-selection-view'
import 'leaflet/dist/leaflet.css'
import './style.css'

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

type JourneyEtaValue = Omit<JourneyEtaEstimate, 'key'> & { source: EtaSource }

const regions: Array<{
  code: RegionCode
  name: string
  center: [number, number]
  maxZoom: number
}> = [
  { code: 'north', name: '北部', center: [24.98, 121.25], maxZoom: 8 },
  { code: 'central', name: '中部', center: [23.95, 120.62], maxZoom: 8 },
  { code: 'south', name: '南部', center: [22.95, 120.35], maxZoom: 8 },
  { code: 'east', name: '東部', center: [23.65, 121.35], maxZoom: 8 },
  { code: 'islands', name: '離島', center: [24.1, 119.25], maxZoom: 7 },
]

const TAIWAN_OVERVIEW_BOUNDS: L.LatLngBoundsExpression = [
  [21.75, 119.85],
  [25.45, 122.05],
]
const desktopMapLayout = window.matchMedia('(min-width: 641px)')

// 舊 renderer 的呼叫點暫留為 migration seam；history 不再建立或補推 sentinel。
function setViewBack(_back?: () => void) {}

function overviewMaxZoom(baseZoom: number): number {
  // 桌機抽屜在側邊，不會吃掉地圖高度；四分之三級能善用多出的工作區，
  // 手機底部抽屜仍維持原本的地理尺度。
  return baseZoom + (desktopMapLayout.matches ? .75 : 0)
}

type TripResultsHistorySnapshot = {
  city: string
  from: NearbyPlace
  to: NearbyPlace
  fromCoordinate?: [number, number]
  toCoordinate?: [number, number]
  directRoutes: DirectRoute[]
  transferPlans: TransferPlan[]
  selectedDirectIndex: number
  selectedTransferIndex: number
}

const mapNode = requiredElement('map')
const drawer = requiredElement('map-drawer')
const drawerRenderer = createDrawerRenderer(drawer)
const renderDrawer = (view: DrawerView) => drawerRenderer.render(view)
const statusNode = requiredElement('map-status')
const mapFeatureDiscovery = createMapFeatureDiscovery(browserStorage())
const networkButton = document.createElement('button')
networkButton.className = 'network-toggle map-feature-button'
networkButton.type = 'button'
networkButton.title = '顯示全路網與全部站點'
networkButton.setAttribute('aria-label', '切換全路網與全部站點')
decorateMapFeatureButton(networkButton, 'network', '▦', '路網')
networkButton.hidden = true
document.getElementById('map-app')?.appendChild(networkButton)

// 觸控裝置沒有 hover、手指也比游標粗得多,才需要放大命中範圍;
// 滑鼠本身夠精準,放大命中範圍反而讓 hover 判定跟不上游標移動(看起來卡住不會變回原狀)。
const hoverCapable = window.matchMedia('(hover: hover)').matches

window.addEventListener('popstate', (event) => {
  if (['overview', 'region', 'catalogue', 'route', 'nearby', 'place', 'trip-select', 'trip-results'].includes(event.state?.mapView)) {
    void hydrateMapLocation()
  }
})

// 互動圖層一律用 SVG:canvas 會以整張地圖大小攔截點擊,
// 疊在上層的 pane 會擋住下層線條的 click(候選路線點不到、誤觸地圖點擊)。
const map = L.map(mapNode, {
  zoomControl: false,
  minZoom: 6,
  maxZoom: 19,
  zoomSnap: .25,
  zoomDelta: .5,
}).setView([23.75, 120.9], overviewMaxZoom(7))
const camera = createMapCameraController(map, mapNode, drawer)

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
let routeSearchQuery = ''
let routeScrollTop = 0
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
let timetableRequest = 0
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
function cancelNavRequest(): void {
  navRequests.cancel()
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
let vehicleRefreshTimer: number | undefined
let vehicleRefreshEpoch = 0
let vehicleRefreshController: AbortController | undefined

const routePalette = ['#b85f49', '#4f685b', '#8a674f', '#b08a47', '#765b78', '#6f7561']
const TRIP_NEARBY_CANDIDATE_LIMIT = 5

const cityNetwork = createCityNetworkController({
  map,
  layer: networkLayer,
  renderer: networkRenderer,
  button: networkButton,
  hoverCapable,
  routeColor,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  loadNetwork: mapApi.network,
  setStatus,
})

function browserStorage(): Storage | undefined {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

function decorateMapFeatureButton(
  button: HTMLButtonElement,
  feature: MapFeature,
  icon: string,
  label: string,
): void {
  const iconNode = document.createElement('span')
  iconNode.className = 'map-feature-icon'
  iconNode.textContent = icon
  iconNode.setAttribute('aria-hidden', 'true')
  const labelNode = document.createElement('span')
  labelNode.className = 'map-feature-label'
  labelNode.textContent = label
  labelNode.setAttribute('aria-hidden', 'true')
  button.replaceChildren(iconNode, labelNode)
  button.classList.toggle('feature-unseen', !mapFeatureDiscovery.hasUsed(feature))
}

function markMapFeatureUsed(button: HTMLButtonElement, feature: MapFeature): void {
  if (mapFeatureDiscovery.hasUsed(feature)) return
  mapFeatureDiscovery.markUsed(feature)
  button.classList.remove('feature-unseen')
}

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
function bindHoverTooltip<T extends L.Layer>(layer: T, content: string, options?: L.TooltipOptions): T {
  if (hoverCapable) bindTextTooltip(layer, content, options)
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
        className: 'preview-stop-dot',
        interactive: false,
      })
      previewStopDots.add(dot)
      return dot
    },
  }).addTo(layerGroup)
}

let initialising = false
void initialise()

async function initialise() {
  if (initialising) return
  initialising = true
  try {
    cities = await mapApi.cities()
    seedInitialMapHistory()
    await hydrateMapLocation()
  } catch {
    renderBootstrapError()
  } finally {
    initialising = false
  }
}

function seedInitialMapHistory() {
  if (history.state?.mapView) return
  const originalUrl = `${location.pathname}${location.search}`
  const params = new URLSearchParams(location.search)
  const cityCode = params.get('city')
  const regionCode = params.get('region') as RegionCode | null
  history.replaceState({ mapView: 'overview' }, '', '/map')
  if (regionCode && regions.some((region) => region.code === regionCode)) {
    history.pushState({ mapView: 'region', mapParent: 'overview' }, '', originalUrl)
    return
  }
  if (!cityCode) return
  const city = cities.find((candidate) => candidate.code === cityCode)
  if (!city) return
  history.pushState({ mapView: 'region', mapParent: 'overview' }, '', `/map?region=${city.region}`)
  history.pushState({ mapView: 'catalogue', mapParent: 'region' }, '', `/map?city=${encodeURIComponent(city.code)}`)
  const mapView = params.has('route')
    ? 'route'
    : params.has('place')
      ? 'place'
      : params.has('lat') && params.has('lon')
        ? 'nearby'
        : params.get('trip') === 'results'
          ? 'trip-results'
          : params.get('trip') === 'select' ? 'trip-select' : undefined
  if (mapView) history.pushState({ mapView, mapParent: 'catalogue' }, '', originalUrl)
}

async function hydrateMapLocation() {
  const params = new URLSearchParams(location.search)
  const regionCode = params.get('region') as RegionCode | null
  if (regionCode && regions.some((region) => region.code === regionCode)) {
    showRegion(regionCode)
    return
  }
  // `/map` 永遠代表全台總覽；恢復縣市必須由可分享、可重整的 city URL 明確表達。
  const cityCode = params.get('city')
  const routeName = params.get('route')
  if (cityCode) {
    const city = cities.find((candidate) => candidate.code === cityCode)
    if (city) {
      if (!history.state?.mapView) {
        history.replaceState({ mapView: 'catalogue' }, '', location.href)
      }
      activeCity = city
      if (routeName) {
        const returnToTrip = history.state?.mapParent === 'trip-results' && restoreTripResultsState()
        await loadRoute(routeName, params.get('variant'), returnToTrip)
      } else {
        if (params.get('trip') === 'results' && restoreTripResultsState()) {
          returnToTripResults()
          return
        }
        if (params.get('trip') === 'results' && await restoreSharedTripResults(params)) return
        if (params.get('trip') === 'select') {
          clearTripState()
          renderTripSelectionStep('from')
          return
        }
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
          camera.focusPoint([latitude, longitude], 15)
          await findNearbyPlaces(latitude, longitude)
        }
      }
      return
    }
  }
  showTaiwan()
}

function renderBootstrapError() {
  const message = '目前無法載入縣市資料，請檢查網路後再試一次。'
  setStatus('地圖初始化失敗，請稍後再試。', true)
  const retry = retryButton(() => {
    retry.disabled = true
    retry.textContent = '重試中…'
    void initialise()
  })
  renderDrawer({
    mode: 'map-list',
    header: [heading('地圖初始化失敗', message)],
    content: [paragraph(message)],
    footer: [retry],
  })
  setDocumentTitle('地圖初始化失敗')
  setViewBack(undefined)
}

networkButton.addEventListener('click', () => {
  markMapFeatureUsed(networkButton, 'network')
  if (activeCity) void cityNetwork.toggle(activeCity)
})
// 品牌鍵 = 回到全台總覽(留在地圖內);右上「首頁」才是離開地圖的出口。
document.getElementById('map-brand')?.addEventListener('click', (event) => {
  event.preventDefault()
  showTaiwan()
})
map.on('zoomend', updateStopMarkerSize)
map.on('click', (event) => {
  if (!activeCity) return
  // 全路網圖層是 non-interactive,點線/點站點都會落到這裡:先問網格索引。
  // 觸控沒有游標精準度,容差比照舊 canvas tolerance 放大。
  const pick = cityNetwork.pickAt(event.latlng, hoverCapable ? 8 : 14, hoverCapable ? 10 : 16)
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
    camera.focusPoint(event.latlng, 14, { animate: true })
    setStatus('放大後再選站牌，避免誤選太遠的位置')
  }
})

function showTaiwan() {
  stopVehicleRefresh()
  cancelNavRequest()
  clearPendingTripSelections()
  clearTripResultsCamera()
  activeCity = undefined
  networkButton.hidden = true
  cityNetwork.hide()
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
  setStatus('選一個區域，看看公車如何穿過城市。')
  renderRegionMarkers()
  renderDrawer({
    mode: 'compact',
    content: [
      heading('先從哪裡開始？', '公車不是清單，是城市的骨架。'),
      buttonGrid(regions.map((region) => ({
        label: region.name,
        onClick: () => openRegion(region.code),
      })), 'map-fallback-grid'),
      locateCityButton(),
    ],
  })
  camera.focusBounds(TAIWAN_OVERVIEW_BOUNDS, { maxZoom: () => overviewMaxZoom(7.5) })
  history.replaceState({ mapView: 'overview' }, '', '/map')
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
    const data = await mapApi.locate()
    if (!cities.length) throw new Error('這次判斷不出位置，直接手動選吧')
    const origin: [number, number] = [data.latitude, data.longitude]
    const nearest = cities.reduce((best, city) =>
      coarseKilometers(city.center, origin) < coarseKilometers(best.center, origin) ? city : best)
    // 離最近縣市中心太遠,代表人大概不在台灣(或 IP 出口在國外),硬跳只會誤導。
    if (coarseKilometers(nearest.center, origin) > 150) throw new Error('看起來你不在台灣附近，直接手動選吧')
    openCity(nearest)
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
    }).on('click', () => openRegion(region.code)).addTo(selectionLayer)
  }
}

function openRegion(regionCode: RegionCode) {
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.pushState({ ...currentState, mapView: 'region', mapParent: 'overview' }, '', `/map?region=${regionCode}`)
  showRegion(regionCode)
}

function returnToOverview() {
  if (history.state?.mapView === 'region' && history.state?.mapParent === 'overview') {
    history.back()
    return
  }
  showTaiwan()
}

function showRegion(regionCode: RegionCode) {
  stopVehicleRefresh()
  cancelNavRequest()
  clearPendingTripSelections()
  clearTripResultsCamera()
  networkButton.hidden = true
  cityNetwork.hide()
  const region = regions.find((candidate) => candidate.code === regionCode)!
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({
    ...currentState,
    mapView: 'region',
    mapParent: currentState.mapView === 'region' ? currentState.mapParent : 'overview',
  }, '', `/map?region=${regionCode}`)
  routeLayer.clearLayers()
  selectionLayer.clearLayers()
  nearbyLayer.clearLayers()
  previewLayer.clearLayers()
  clearStatus()
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
    }).on('click', () => openCity(city)).addTo(selectionLayer)
  }
  renderDrawer({
    mode: 'compact',
    content: [
      drawerBack('返回區域', returnToOverview),
      heading(region.name, '直接點地圖上的縣市，或從這裡選。'),
      buttonGrid(regionCities.map((city) => ({
        label: city.name,
        onClick: () => openCity(city),
      })), 'map-fallback-grid'),
    ],
  })
  fitRegionCities(region, regionCities)
  setViewBack(returnToOverview)
}

function openCity(city: MapCity) {
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  if (currentState.mapView !== 'region') {
    history.pushState({ ...currentState, mapView: 'region', mapParent: 'overview' }, '', `/map?region=${city.region}`)
  }
  history.pushState({
    ...history.state,
    mapView: 'catalogue',
    mapParent: 'region',
  }, '', `/map?city=${encodeURIComponent(city.code)}`)
  void chooseCity(city)
}

function returnToRegion() {
  if (history.state?.mapView === 'catalogue' && history.state?.mapParent === 'region') {
    history.back()
    return
  }
  if (activeCity) showRegion(activeCity.region)
}

async function chooseCity(city: MapCity) {
  stopVehicleRefresh()
  clearPendingTripSelections()
  clearTripResultsCamera()
  activeCity = city
  setActiveCity(city.code)
  category = '全部'
  routeSearchQuery = ''
  routeScrollTop = 0
  const { requestId, signal } = beginNavRequest()
  networkButton.hidden = false
  cityNetwork.hide()
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
  setDocumentTitle(`${city.name}公車地圖`)
  setStatus(`${city.name} · 正在整理路線…`)
  renderDrawer({
    mode: 'compact',
    content: [drawerBack('返回區域', returnToRegion), heading(city.name, '正在載入路線…')],
  })
  camera.focusPoint(city.center, 11)
  setViewBack(returnToRegion)

  try {
    const loadedRoutes = await mapApi.routes(city.code, signal)
    if (isStaleNav(requestId)) return
    routes = loadedRoutes
    routesCityCode = city.code
    category = '全部'
    renderRoutePicker()
    camera.focusPoint(city.center, 11)
  } catch {
    if (isStaleNav(requestId)) return
    setStatus('目前無法載入這個縣市的路線。', true)
    renderDrawer({
      mode: 'compact',
      content: [
        drawerBack('返回區域', returnToRegion),
        heading(city.name, '目前無法載入這個縣市的路線。'),
        retryButton(() => void chooseCity(city)),
      ],
    })
    camera.focusPoint(city.center, 11)
  }
}

function renderRoutePicker() {
  if (!activeCity) return
  stopVehicleRefresh()
  cancelNavRequest()
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
    renderDrawer({
      mode: 'compact',
      content: [
        drawerBack('返回縣市', returnToRegion),
        heading(activeCity.name, '正在載入路線…'),
      ],
    })
    setViewBack(returnToRegion)
    const cityCode = activeCity.code
    void (async () => {
      try {
        routes = await mapApi.routes(cityCode)
        routesCityCode = cityCode
        category = '全部'
        // 載回來時使用者可能已經離開選單(開了路線、換了城市),別把畫面搶回來
        if (interactionMode === 'browse' && activeCity?.code === cityCode) renderRoutePicker()
      } catch {
        // 同樣不能把失敗畫面搶回使用者已經離開的城市/選單
        if (interactionMode !== 'browse' || activeCity?.code !== cityCode) return
        setStatus('目前無法載入這個縣市的路線。', true)
        renderDrawer({
          mode: 'compact',
          content: [
            drawerBack('返回縣市', returnToRegion),
            heading(activeCity!.name, '目前無法載入這個縣市的路線。'),
            retryButton(() => renderRoutePicker()),
          ],
        })
      }
    })()
    return
  }
  const back = drawerBack('返回縣市', returnToRegion)
  const title = heading(activeCity.name, `${routes.length} 條路線，不用設定起終點，直接看一條公車。`)
  const search = document.createElement('input')
  search.className = 'map-search map-route-search'
  search.placeholder = '路線或站牌名稱'
  search.setAttribute('aria-label', '篩選路線，或搜尋站牌名稱')
  const categories = document.createElement('div')
  categories.className = 'map-categories'
  const stopResults = document.createElement('div')
  stopResults.className = 'place-search-results'
  const routeGrid = document.createElement('div')
  routeGrid.className = 'map-route-grid'
  const drawerSession = renderDrawer({
    mode: 'map-list',
    header: [back, title, tripModeButton(), search, categories],
    content: [stopResults, routeGrid],
  })
  const listRegion = drawerSession.scrollRegion!

  const savedCatalogue = history.state?.routeCatalogue as {
    city?: unknown
    query?: unknown
    category?: unknown
    scrollTop?: unknown
  } | undefined
  if (savedCatalogue?.city === activeCity.code) {
    if (typeof savedCatalogue.query === 'string') routeSearchQuery = savedCatalogue.query
    if (typeof savedCatalogue.category === 'string') category = savedCatalogue.category
    if (typeof savedCatalogue.scrollTop === 'number') routeScrollTop = Math.max(0, savedCatalogue.scrollTop)
  }
  search.value = routeSearchQuery

  const counts = new Map<string, number>()
  routes.forEach((route) => counts.set(route.category, (counts.get(route.category) ?? 0) + 1))
  const names = ['全部', ...['數字', '幹線', '接駁', '幸福／社區', '觀光', '小黃', '公路客運', '其他'].filter((name) => counts.has(name))]

  const render = () => {
    categories.replaceChildren(...names.map((name) => {
      const button = document.createElement('button')
      button.className = `map-chip${category === name ? ' active' : ''}`
      const label = name === '幸福／社區' ? '幸福・社區' : name
      button.textContent = name === '全部' ? `${label} ${routes.length}` : label
      button.setAttribute('aria-pressed', String(category === name))
      button.addEventListener('click', () => {
        category = name
        routeScrollTop = 0
        listRegion.scrollTop = 0
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
      button.setAttribute('aria-label', route.routeName)
      const display = splitRouteDisplayName(route.routeName)
      const name = document.createElement('strong')
      name.textContent = display.name
      button.appendChild(name)
      if (display.note) {
        const note = document.createElement('small')
        note.textContent = display.note
        button.appendChild(note)
      }
      button.addEventListener('click', () => openCatalogueRoute(route.routeName))
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
        const places = await searchPlaces(query, drawerSession.signal)
        if (drawerSession.signal.aborted) return
        if (search.value.trim() !== query) return
        stopResults.replaceChildren(...places.slice(0, 6).map((place) => createPlaceSearchResultButton(place, openSearchedPlace)))
      })()
    }, 300)
  }
  drawerSession.onDispose(() => window.clearTimeout(stopSearchTimer))
  search.addEventListener('input', () => {
    routeSearchQuery = search.value
    routeScrollTop = 0
    listRegion.scrollTop = 0
    render()
    queueStopSearch()
  })
  listRegion.addEventListener('scroll', () => { routeScrollTop = listRegion.scrollTop }, { passive: true })
  render()
  listRegion.scrollTop = routeScrollTop
  saveRouteCatalogueState('/map?city=' + encodeURIComponent(activeCity.code))
  clearStatus()
  setViewBack(returnToRegion)
}

function saveRouteCatalogueState(url = location.href) {
  if (!activeCity) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({
    ...currentState,
    mapView: 'catalogue',
    routeCatalogue: {
      city: activeCity.code,
      query: routeSearchQuery,
      category,
      scrollTop: routeScrollTop,
    },
  }, '', url)
}

function openCatalogueRoute(routeName: string) {
  if (!activeCity) return
  saveRouteCatalogueState()
  history.pushState({
    ...history.state,
    mapView: 'route',
    mapParent: 'catalogue',
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&route=${encodeURIComponent(routeName)}`)
  void loadRoute(routeName)
}

async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchPlace[]> {
  if (!activeCity) return []
  try {
    return await mapApi.search(activeCity.code, query, signal)
  } catch {
    return []
  }
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

function tripMatchedSummary(kind: TripSelectionKind): HTMLElement | undefined {
  const selected = kind === 'from' ? selectedFrom : selectedTo
  if (!selected) return
  const pending = pendingTripSelection(kind)
  return createTripEndpointSummary({
    kind,
    selected,
    matchedDistanceMeters: pending?.selected.distanceMeters,
    onActivate: () => {
      if (pendingTripSelection(kind)) {
        renderPendingTripCandidates(kind)
        return
      }
      resumeTripEndpointSelection(kind)
    },
  })
}

function resumeTripEndpointSelection(kind: TripSelectionKind) {
  if (kind === 'from') resumeOriginSelection()
  else resumeDestinationSelection()
}

function tripMatchedControls(compact = false): HTMLElement | undefined {
  const from = tripMatchedSummary('from')
  const to = tripMatchedSummary('to')
  if (!from && !to) return
  const controls = document.createElement('div')
  controls.className = 'trip-matched-controls'
  controls.classList.toggle('compact', compact)
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
  const list = createTripCandidateList({
    candidates: pending.candidates,
    selectedPlaceId: pending.selected.placeId,
    onSelect: (candidate) => void selectTripCandidate(kind, candidate),
  })
  const backAction = hasTripResults() ? returnToTripResults : () => renderTripSelectionStep(kind)
  renderDrawer({
    mode: 'map-list',
    header: [
      drawerBack(hasTripResults() ? '返回行程候選' : '返回選點', backAction),
      heading(
        kind === 'from' ? '選擇出發站牌' : '選擇目的地站牌',
        '點選附近站牌，或重新選位置。',
      ),
    ],
    content: [list],
    footer: [createReselectTripEndpointButton(kind, () => resumeTripEndpointSelection(kind))],
  })
  setStatus(`${kind === 'from' ? '出發' : '目的地'} · ${pending.candidates.length} 個附近站牌`)
  setViewBack(backAction)
}

function renderTripSelectionStep(nextKind: TripSelectionKind) {
  tripStage = nextKind
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  drawTripEndpoints()
  const existingKind: TripSelectionKind = nextKind === 'from' ? 'to' : 'from'
  const existingSummary = tripMatchedSummary(existingKind)
  const searchLabel = nextKind === 'from' ? '搜尋出發站牌' : '搜尋目的地站牌'
  const title = nextKind === 'from' ? '點一下出發位置' : '再點一下目的地'
  const description = nextKind === 'from'
    ? '點地圖或搜尋站牌。'
    : `已選擇「${selectedFrom?.name ?? ''}」，再點目的地或搜尋站牌。`
  const searchBox = createPlaceSearchBox({
    placeholder: searchLabel,
    search: searchPlaces,
    onPick: (place) => void selectTripPlace(nextKind, place),
  })
  const drawerSession = renderDrawer({
    mode: 'compact',
    content: [
      drawerBack('取消路線規劃', cancelTripMode),
      heading(title, description),
      existingSummary ?? document.createDocumentFragment(),
      searchBox.element,
    ],
  })
  drawerSession.onDispose(searchBox.dispose)
  clearStatus()
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
    cityNetwork.hide()
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

// 搜尋選中的站牌直接開站牌路線視圖(跟 deep link 進站牌同一條路)。
function openSearchedPlace(place: SearchPlace) {
  camera.focusPoint([place.latitude, place.longitude], 16)
  const nearbyPlace: NearbyPlace = { ...place, distanceMeters: 0 }
  lastNearbyOrigin = [place.latitude, place.longitude]
  lastNearbyPlaces = [nearbyPlace]
  interactionMode = 'nearby'
  void showPlaceRoutes(nearbyPlace)
}

function tripModeButton(): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'trip-mode-button map-feature-button'
  button.title = '路線規劃'
  button.setAttribute('aria-label', '路線規劃：選擇出發位置與目的地')
  decorateMapFeatureButton(button, 'trip', '↗', '規劃')
  button.addEventListener('click', () => {
    markMapFeatureUsed(button, 'trip')
    if (activeCity) {
      const currentState = history.state && typeof history.state === 'object' ? history.state : {}
      const nextState = { ...currentState, mapView: 'trip-select', mapParent: currentState.mapView }
      const url = `/map?city=${encodeURIComponent(activeCity.code)}&trip=select`
      if (currentState.mapView === 'trip-results') history.replaceState(nextState, '', url)
      else history.pushState(nextState, '', url)
    }
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
  if (history.state?.mapView === 'trip-select' && history.state?.mapParent) {
    history.back()
    return
  }
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
  camera.clear()
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
  if (history.state?.mapView === 'route' && history.state?.mapParent === 'trip-results') {
    history.back()
    return
  }
  cancelNavRequest()
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
      } else {
        renderRoutePicker()
      }
    }
  }
  if (target === 'stop-view') return () => (routeBackAction ?? renderRoutePicker)()
  return returnToRoutePicker
}

function returnToRoutePicker() {
  if (history.state?.mapView === 'route' && history.state?.mapParent === 'catalogue') {
    history.back()
    return
  }
  renderRoutePicker()
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
    bindTextTooltip(unifiedStopMarker(fromCoordinate, true, '#b85f49'), '出發位置', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
  if (toCoordinate) {
    bindTextTooltip(unifiedStopMarker(toCoordinate, true, '#4f685b'), '目的地', { permanent: true, direction: 'top' }).addTo(nearbyLayer)
  }
}

function openTripRoute(
  routeName: string,
  preferredVariant: string | null | undefined,
  color: string,
  backAction?: () => void,
) {
  captureTripResultsCamera()
  writeTripResultsUrl()
  if (activeCity) {
    history.pushState({
      ...history.state,
      mapView: 'route',
      mapParent: 'trip-results',
    }, '', `/map?city=${encodeURIComponent(activeCity.code)}&route=${encodeURIComponent(routeName)}${preferredVariant ? `&variant=${encodeURIComponent(preferredVariant)}` : ''}`)
  }
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
  cityNetwork.hide()
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
  renderDrawer({
    mode: 'compact',
    content: [drawerBack(loading.label, loadingBack), heading(routeName, '正在拼起路線與站牌…')],
  })
  setViewBack(loadingBack)
  try {
    const variants = await mapApi.routeVariants(activeCity.code, routeName, signal)
    if (isStaleNav(requestId)) return
    const preferred = variants.find((variant) => variant.variantKey === preferredVariant)
    lastVariantChoices = { routeName, variants }
    variantPickerUsed = !preferred && variants.length > 1
    if (preferred) {
      drawVariant(preferred)
    } else if (variants.length === 1) {
      drawVariant(variants[0])
    } else {
      renderVariantPicker(routeName, variants)
    }
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '目前無法取得這條路線。'
    setStatus(message, true)
    renderDrawer({
      mode: 'compact',
      content: [
        drawerBack(loading.label, loadingBack),
        heading(routeName, message),
        retryButton(() => void loadRoute(routeName, preferredVariant, returnToTrip, color, backAction)),
      ],
    })
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
  // 支線常常走同一條走廊、幾何幾乎重疊:反序繪製讓列表第一項壓在最上,
  // 其餘降透明度,地圖上看到的顏色才對得上列表的第一個色帶。
  variants.map((variant, index) => ({ variant, index })).reverse().forEach(({ variant, index }) => {
    const color = routePalette[index % routePalette.length]
    const style = { color, weight: 5.5, opacity: index === 0 ? .62 : .3, lineCap: 'round' as const, lineJoin: 'round' as const }
    const { line, target } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, style)
    addPreviewStopDots(variant.stops, color, previewLayer)
    bindHoverTooltip(target, `${variant.label} · ${variant.subRouteName}`, { sticky: true })
    target.on('mouseover', () => {
      line.setStyle({ ...style, weight: 8, opacity: .9 })
      line.bringToFront()
    })
    target.on('mouseout', () => {
      line.setStyle(style)
      if (index !== 0) previewsByKey.get(variants[0].variantKey)?.line.bringToFront()
    })
    target.on('click', (event) => {
      L.DomEvent.stopPropagation(event)
      drawVariant(variant)
    })
    previewsByKey.set(variant.variantKey, { line, style })
    bounds.extend(line.getBounds())
  })
  const list = document.createElement('div')
  list.className = 'variant-list'
  list.replaceChildren(...variants.map((variant, index) => {
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
    button.addEventListener('click', () => drawVariant(variant))
    button.addEventListener('mouseenter', () => {
      const preview = previewsByKey.get(variant.variantKey)
      preview?.line.setStyle({ ...preview.style, weight: 8, opacity: .9 })
      preview?.line.bringToFront()
    })
    button.addEventListener('mouseleave', () => {
      const preview = previewsByKey.get(variant.variantKey)
      preview?.line.setStyle(preview.style)
      if (variant.variantKey !== variants[0].variantKey) previewsByKey.get(variants[0].variantKey)?.line.bringToFront()
    })
    return button
  }))
  // 行程候選帶著過期的 variantKey 進來時會落到這裡,退路一樣要回候選清單
  const decision = routeLoadingBack({ returnToTrip: routeReturnsToTrip, hasStopBackAction: Boolean(routeBackAction) })
  const variantBack = backActionFor(decision.target)
  renderDrawer({
    mode: 'map-list',
    header: [
      drawerBack(decision.label, variantBack),
      heading(routeName, '同一路線可能穿過不同街廓，點線或點列表選一條。'),
    ],
    content: [list],
  })
  if (bounds.isValid()) camera.focusBounds(bounds)
  clearStatus()
  setViewBack(variantBack)
  history.replaceState(history.state, '', `/map?city=${encodeURIComponent(activeCity!.code)}&route=${encodeURIComponent(routeName)}`)
}


// 摘要列從一開始就佔位(pending),資料到了原地變成可點的時刻表入口;
// 版面高度不變,就不需要第二次 fitBounds,畫面也不會跳。
async function hydrateRouteTimetableSummary(
  variant: RouteMapVariant,
  summary: HTMLButtonElement,
  requestId: number,
) {
  if (!activeCity) return
  try {
    const data = await mapApi.timetable(activeCity.code, variant)
    if (requestId !== timetableRequest || !drawer.contains(summary)) return
    if (data.timetable.mode === 'none' || !data.timetable.services.length) {
      summary.remove()
      return
    }
    renderTimetableSummary(summary, timetableSummaryText(data.timetable) ?? '查看時刻表')
    summary.classList.remove('pending')
    summary.disabled = false
    summary.setAttribute('aria-label', '查看時刻表')
    summary.addEventListener('click', () => void openRouteTimetable(variant))
  } catch {
    // 時刻是輔助資訊,拿不到就整列收掉,不打斷路線地圖與車輛定位。
    if (requestId === timetableRequest && drawer.contains(summary)) summary.remove()
  }
}

async function openRouteTimetable(variant: RouteMapVariant, stopUid?: string) {
  if (!activeCity) return
  stopVehicleRefresh()
  const back = () => drawVariant(variant)
  const { requestId, signal } = beginNavRequest()
  timetableRequest += 1
  renderDrawer({
    mode: 'timetable',
    header: [
      drawerBack(`返回 ${variant.routeName}`, back),
      heading(variant.routeName, `時刻 · ${variant.label}`),
    ],
    content: [paragraph('正在整理表定班次…')],
  })
  setStatus(`${variant.routeName} · 正在讀取時刻`)
  setViewBack(back)
  try {
    const data = await mapApi.timetable(activeCity.code, variant, stopUid, signal)
    if (isStaleNav(requestId)) return
    renderRouteTimetable(variant, data.timetable)
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error ? error.message : '目前無法取得時刻表'
    renderDrawer({
      mode: 'timetable',
      header: [
        drawerBack(`返回 ${variant.routeName}`, back),
        heading(variant.routeName, message),
      ],
      content: [retryButton(() => void openRouteTimetable(variant, stopUid))],
    })
    setStatus(message, true)
  }
}

function focusTimetableStop(variant: RouteMapVariant, stop: Omit<TimetableStop, 'hasTimes'>) {
  selectionLayer.clearLayers()
  const feature = variant.stops.features.find((candidate) => candidate.properties.stopUid === stop.stopUid)
  if (!feature) return
  const [longitude, latitude] = feature.geometry.coordinates
  camera.focusPoint([latitude, longitude], 15)
  const marker = unifiedStopMarker([latitude, longitude], true, '#b85f49').addTo(selectionLayer)
  marker.getElement()?.classList.add('timetable-stop-focus')
  marker.getElement()?.setAttribute('data-stop-uid', stop.stopUid)
}

function renderRouteTimetable(variant: RouteMapVariant, timetable: RouteTimetable) {
  const back = () => drawVariant(variant)
  if (timetable.mode === 'none' || !timetable.services.length) {
    const panel = document.createElement('div')
    panel.className = 'timetable-panel'
    panel.appendChild(paragraph('這個方向目前沒有公開的表定班次資料。'))
    renderDrawer({
      mode: 'timetable',
      header: [
        drawerBack(`返回 ${variant.routeName}`, back),
        heading(variant.routeName, `時刻 · ${variant.label}`),
      ],
      content: [panel],
    })
    setStatus(`${variant.routeName} · 無公開時刻資料`)
    setViewBack(back)
    return
  }

  const panel = createTimetablePanel(timetable, (stopUid) => void openRouteTimetable(variant, stopUid))
  renderDrawer({
    mode: 'timetable',
    header: [
      drawerBack(`返回 ${variant.routeName}`, back),
      heading(variant.routeName, `時刻 · ${variant.label}`),
    ],
    content: [panel],
  })
  if (timetable.mode === 'stop' && timetable.selectedStop) {
    queueMicrotask(() => focusTimetableStop(variant, timetable.selectedStop!))
  } else {
    selectionLayer.clearLayers()
  }
  clearStatus()
  setViewBack(back)
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
  clearStatus()
  const canReturnToVariantPicker = !routeReturnsToTrip
    && variantPickerUsed
    && lastVariantChoices?.routeName === variant.routeName
    && (lastVariantChoices?.variants.length ?? 0) > 1
  const backContext = () => ({
    returnToTrip: routeReturnsToTrip,
    hasTripResults: hasTripResults(),
    canReturnToVariantPicker,
    hasStopBackAction: Boolean(routeBackAction),
  })
  // 目標在按下時才決定:行程候選可能在停留期間被丟棄,要退到降級後的那一層。
  const goBack = () => backActionFor(routeViewBack(backContext()).target)()
  const timetableSummary = document.createElement('button')
  timetableSummary.type = 'button'
  timetableSummary.className = 'route-service-summary pending'
  timetableSummary.textContent = '正在讀取時刻…'
  timetableSummary.disabled = true
  renderDrawer({
    mode: 'compact',
    content: [
      drawerBack(routeViewBack(backContext()).label, goBack),
      heading(variant.routeName, `${variant.label} · ${variant.stops.features.length} 站`),
      // 支線名和路線編號相同時(單支線路線很常見)就別再唸一次。
      ...(variant.subRouteName && variant.subRouteName !== variant.routeName ? [paragraph(variant.subRouteName)] : []),
      timetableSummary,
    ],
  })
  if (bounds.isValid()) camera.focusBounds(bounds)
  const summaryRequest = ++timetableRequest
  void hydrateRouteTimetableSummary(variant, timetableSummary, summaryRequest)
  setViewBack(goBack)
  const params = new URLSearchParams({
    city: activeCity!.code,
    route: variant.routeName,
    routeUid: variant.routeUid,
    direction: String(variant.direction),
    variant: variant.variantKey,
  })
  history.replaceState(history.state, '', `/map?${params}`)
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
  cityNetwork.resizeStopMarkers()
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
  if (!activeCity) return
  const cityCode = activeCity.code
  const sessionEpoch = ++vehicleRefreshEpoch
  const refresh = async () => {
    if (vehicleRefreshEpoch !== sessionEpoch || activeCity?.code !== cityCode || interactionMode !== 'route') return
    vehicleRefreshController?.abort()
    const controller = new AbortController()
    vehicleRefreshController = controller
    try {
      const vehicles = await mapApi.vehicles(cityCode, variant, controller.signal)
      if (
        controller.signal.aborted
        || vehicleRefreshEpoch !== sessionEpoch
        || activeCity?.code !== cityCode
        || interactionMode !== 'route'
      ) return
      vehicleLayer.clearLayers()
      vehicles.forEach((vehicle) => {
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
        bindHoverTooltip(marker, `${vehicle.plate ?? '公車'}${vehicle.speed === null ? '' : ` · ${Math.round(vehicle.speed)} km/h`}`).addTo(vehicleLayer)
      })
    } catch {
      // 車輛定位是輔助資訊，失敗時保留主路線而不打斷操作。
    } finally {
      if (vehicleRefreshController === controller) vehicleRefreshController = undefined
    }
  }
  void refresh()
  vehicleRefreshTimer = window.setInterval(() => void refresh(), 20_000)
}

function stopVehicleRefresh() {
  vehicleRefreshEpoch += 1
  vehicleRefreshController?.abort()
  vehicleRefreshController = undefined
  if (vehicleRefreshTimer !== undefined) window.clearInterval(vehicleRefreshTimer)
  vehicleRefreshTimer = undefined
  vehicleLayer.clearLayers()
}

async function findNearbyPlaces(latitude: number, longitude: number, autoPreview = false) {
  if (!activeCity) return
  stopVehicleRefresh()
  cityNetwork.hide()
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
  renderDrawer({
    mode: 'map-list',
    header: [
      drawerBack('附近站牌', renderNearbyPlaces),
      heading('附近站牌', '正在搜尋附近站牌'),
    ],
    content: [loadingList],
  })
  setViewBack(renderRoutePicker)
  nearbyLayer.clearLayers()
  lastNearbyOrigin = [latitude, longitude]
  const city = activeCity
  const radius = map.getZoom() >= 15 ? 300 : 500
  unifiedStopMarker([latitude, longitude], true, '#b85f49').addTo(nearbyLayer)
  setStatus('正在找這附近的站牌…')
  const { requestId, signal } = beginNavRequest()

  try {
    const places = await mapApi.nearby(city.code, latitude, longitude, radius, signal)
    if (isStaleNav(requestId)) return
    lastNearbyPlaces = places.slice(0, 12)
    renderNearbyPlaces()
    if (autoPreview && lastNearbyPlaces[0]) await openNearbyPlace(lastNearbyPlaces[0])
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '附近站牌讀取失敗'
    setStatus(message, true)
    renderDrawer({
      mode: 'map-list',
      header: [
        drawerBack('附近站牌', renderNearbyPlaces),
        heading('附近站牌讀取失敗', message),
      ],
      content: [retryButton(() => void findNearbyPlaces(latitude, longitude, autoPreview))],
    })
  }
}

function renderNearbyPlaces() {
  if (!activeCity || !lastNearbyOrigin) return
  cancelNavRequest()
  nearbyLayer.clearLayers()
  const origin = unifiedStopMarker(lastNearbyOrigin, true, '#b85f49').addTo(nearbyLayer)
  bindHoverTooltip(origin, '你點的位置')

  for (const place of lastNearbyPlaces) {
    bindHoverTooltip(unifiedStopMarker([place.latitude, place.longitude], true), `${place.name} · ${Math.round(place.distanceMeters)} m`)
      .on('click', (event) => {
        L.DomEvent.stopPropagation(event)
        void openNearbyPlace(place)
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
    button.addEventListener('click', () => void openNearbyPlace(place))
    list.appendChild(button)
  }
  const managedNearbyParent = history.state?.mapView === 'nearby' && history.state?.mapParent
  const nearbyBack = managedNearbyParent
    ? () => history.back()
    : hasTripResults() ? returnToTripResults : renderRoutePicker
  const nearbyBackLabel = history.state?.mapParent === 'route'
    ? '返回路線'
    : hasTripResults() ? '返回行程候選' : '路線列表'
  renderDrawer({
    mode: 'map-list',
    header: [
      drawerBack(nearbyBackLabel, nearbyBack),
      heading(
        '附近站牌',
        lastNearbyPlaces.length
          ? `${lastNearbyPlaces.length} 個附近站牌，點任一站牌預覽所有經過路線。`
          : '附近沒有站牌。',
      ),
    ],
    content: [list],
    footer: [tripModeButton()],
  })
  clearStatus()
  const [latitude, longitude] = lastNearbyOrigin
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'nearby' }, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
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
  const cityCode = activeCity.code
  const { requestId, signal } = beginNavRequest()
  tripSelecting = true
  clearPendingTripSelection(kind)
  const radius = map.getZoom() >= 15 ? 300 : 500
  setStatus('正在尋找附近站牌…')
  try {
    const places = await mapApi.nearby(cityCode, latitude, longitude, radius, signal)
    if (signal.aborted || isStaleNav(requestId) || activeCity?.code !== cityCode || tripStage !== kind) return
    const candidates = places.slice(0, TRIP_NEARBY_CANDIDATE_LIMIT)
    const nearest = candidates[0]
    if (!nearest) throw new Error('這附近沒有站牌')
    setPendingTripSelection({ kind, coordinate: [latitude, longitude], candidates, selected: nearest })
    await applyTripSelection(kind, nearest, [latitude, longitude])
  } catch (error) {
    if (signal.aborted || isStaleNav(requestId)) return
    setStatus(error instanceof Error ? error.message : '附近站牌讀取失敗', true)
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
    const directRoutes = await mapApi.direct(activeCity.code, from.placeId, to.placeId, signal)
    if (isStaleNav(requestId)) return
    if (directRoutes.length) {
      const rankedRoutes = await rankDirectRoutesByEta(directRoutes)
      if (isStaleNav(requestId)) return
      lastDirectRoutes = rankedRoutes
      lastTransferPlans = []
      selectedDirectIndex = 0
      renderDirectRoutes(rankedRoutes)
      await previewDirectRoutes(rankedRoutes, { fitCamera: true })
      return
    }
    setStatus('沒有直達車，正在找一次轉乘…')
    const transferPlans = await mapApi.transfer(activeCity.code, from.placeId, to.placeId, signal)
    if (isStaleNav(requestId)) return
    lastDirectRoutes = []
    selectedDirectIndex = 0
    const rankedPlans = await rankTransferPlansByEta(transferPlans)
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
    renderDrawer({
      mode: 'compact',
      content: [
        drawerBack('重新選目的地', resumeDestinationSelection),
        heading('查詢失敗了', `${from.name} → ${to.name} 暫時查不到，稍等一下再試。`),
        retryButton(() => void loadDirectRoutes()),
      ],
    })
    setViewBack(resumeDestinationSelection)
  }
}

async function fetchJourneyEta(legs: Array<{ key: string; patternId: string; sequence: number }>) {
  if (!activeCity || !legs.length) return new Map<string, JourneyEtaValue>()
  try {
    const estimates = await mapApi.journeyEta(activeCity.code, legs)
    return new Map(estimates.map((estimate) => [
      estimate.key,
      {
        minutes: estimate.minutes,
        source: estimate.source ?? 'none',
        departureBased: estimate.departureBased ?? false,
        headwayMinutes: estimate.headwayMinutes ?? null,
        nextDay: estimate.nextDay ?? false,
      },
    ]))
  } catch {
    return new Map<string, JourneyEtaValue>()
  }
}

async function rankDirectRoutesByEta(routesToRank: DirectRoute[]): Promise<DirectRoute[]> {
  const estimates = await fetchJourneyEta(routesToRank.map((route, index) => ({
    key: `direct:${index}`,
    patternId: route.variantKey,
    sequence: route.boardSequence,
  })))
  return routesToRank.map((route, index) => {
    const estimate = estimates.get(`direct:${index}`)
    return {
      ...route,
      etaMinutes: estimate?.minutes ?? null,
      etaSource: estimate?.source ?? 'none',
      etaDepartureBased: estimate?.departureBased ?? false,
      etaHeadwayMinutes: estimate?.headwayMinutes ?? null,
      etaNextDay: estimate?.nextDay ?? false,
    }
  }).sort((a, b) =>
    sortableJourneyMinutes(a) - sortableJourneyMinutes(b)
    || a.stopCount - b.stopCount,
  )
}

function sortableJourneyMinutes(route: DirectRoute): number {
  if (route.etaDepartureBased || route.etaHeadwayMinutes || route.etaNextDay) return Number.POSITIVE_INFINITY
  return route.etaMinutes ?? Number.POSITIVE_INFINITY
}

function isReliableJourneyArrival(estimate: JourneyEtaValue | undefined): boolean {
  return estimate?.source === 'realtime'
    && estimate.minutes !== null
    && !estimate.departureBased
    && !estimate.headwayMinutes
    && !estimate.nextDay
}

async function rankTransferPlansByEta(plans: TransferPlan[]): Promise<TransferPlan[]> {
  const estimates = await fetchJourneyEta(plans.flatMap((plan, index) => [
    { key: `transfer:${index}:first`, patternId: plan.first.variantKey, sequence: plan.first.boardSequence },
    { key: `transfer:${index}:second`, patternId: plan.second.variantKey, sequence: plan.second.boardSequence },
  ]))
  return plans.map((plan, index) => {
    const firstEstimate = estimates.get(`transfer:${index}:first`)
    const secondEstimate = estimates.get(`transfer:${index}:second`)
    const firstEta = firstEstimate?.minutes ?? null
    const secondEta = secondEstimate?.minutes ?? null
    const estimate = estimateTransfer({
      firstStopCount: plan.first.stopCount,
      secondStopCount: plan.second.stopCount,
      walkMeters: plan.transferWalkMeters ?? 0,
      firstEtaMinutes: firstEta,
      secondEtaMinutes: secondEta,
      firstEtaReliable: isReliableJourneyArrival(firstEstimate),
      secondEtaReliable: isReliableJourneyArrival(secondEstimate),
    })
    return {
      ...plan,
      firstEtaMinutes: firstEta,
      secondEtaMinutes: secondEta,
      firstEtaSource: firstEstimate?.source ?? 'none',
      secondEtaSource: secondEstimate?.source ?? 'none',
      firstEtaDepartureBased: firstEstimate?.departureBased ?? false,
      secondEtaDepartureBased: secondEstimate?.departureBased ?? false,
      firstEtaHeadwayMinutes: firstEstimate?.headwayMinutes ?? null,
      secondEtaHeadwayMinutes: secondEstimate?.headwayMinutes ?? null,
      firstEtaNextDay: firstEstimate?.nextDay ?? false,
      secondEtaNextDay: secondEstimate?.nextDay ?? false,
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
  writeTripResultsUrl()
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
    const wait = formatJourneyWait(route.etaMinutes, route.etaSource, new Date(), {
      departureBased: route.etaDepartureBased,
      headwayMinutes: route.etaHeadwayMinutes,
      nextDay: route.etaNextDay,
    })
    count.textContent = wait ? `${wait} · ${route.stopCount} 站` : `${route.stopCount} 站`
    top.appendChild(name)
    top.appendChild(count)
    const detail = document.createElement('small')
    detail.textContent = route.label
    button.appendChild(top)
    button.appendChild(detail)
    button.addEventListener('click', () => {
      selectedDirectIndex = index
      renderDirectRoutes(directRoutes)
      void previewDirectRoutes(directRoutes, { fitCamera: true })
    })
    const detailButton = document.createElement('button')
    detailButton.type = 'button'
    detailButton.className = 'direct-route-detail'
    detailButton.textContent = '完整路線 ›'
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
  const matchedControls = tripMatchedControls(true)
  renderDrawer({
    mode: 'results',
    header: [
      back,
      heading(`${selectedFrom.name} → ${selectedTo.name}`, directRoutes.length ? `${directRoutes.length} 個直達方向，淡色線為候選路線。` : '沒有直達路線'),
      ...(matchedControls ? [matchedControls] : []),
    ],
    content: [list],
    footer: [reset],
  })
  clearStatus()
  setViewBack(resumeDestinationSelection)
}

function renderTransferPlans(plans: TransferPlan[]) {
  if (!selectedFrom || !selectedTo) return
  interactionMode = 'trip-results'
  writeTripResultsUrl()
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
    transfer.textContent = '一次轉乘'
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
      const etaSource = legIndex === 0 ? plan.firstEtaSource : plan.secondEtaSource
      const wait = formatJourneyWait(eta, etaSource, new Date(), {
        departureBased: legIndex === 0 ? plan.firstEtaDepartureBased : plan.secondEtaDepartureBased,
        headwayMinutes: legIndex === 0 ? plan.firstEtaHeadwayMinutes : plan.secondEtaHeadwayMinutes,
        nextDay: legIndex === 0 ? plan.firstEtaNextDay : plan.secondEtaNextDay,
      })
      stops.textContent = `${wait ? `${wait} · ` : ''}${leg.stopCount} 站 · ${leg.label}`
      button.appendChild(order)
      button.appendChild(routeName)
      button.appendChild(stops)
      button.addEventListener('click', (event) => {
        event.stopPropagation()
        openTripRoute(leg.routeName, leg.variantKey, color)
      })
      card.appendChild(button)
      if (legIndex === 0) {
        const connection = document.createElement('div')
        connection.className = 'transfer-connection'
        const icon = document.createElement('span')
        icon.textContent = '↳'
        icon.setAttribute('aria-hidden', 'true')
        const copy = document.createElement('strong')
        copy.textContent = `於 ${plan.transferName} 轉乘`
        const walk = document.createElement('small')
        walk.textContent = plan.transferWalkMeters ? `步行約 ${plan.transferWalkMeters} m` : '同站轉乘'
        connection.appendChild(icon)
        connection.appendChild(copy)
        connection.appendChild(walk)
        card.appendChild(connection)
      }
    })
    list.appendChild(card)
  })
  const matchedControls = tripMatchedControls(true)
  renderDrawer({
    mode: 'results',
    header: [
      drawerBack('重新選目的地', resumeDestinationSelection),
      heading(`${selectedFrom.name} → ${selectedTo.name}`, plans.length ? `${plans.length} 個一次轉乘方案` : '沒有直達或一次轉乘方案'),
      ...(matchedControls ? [matchedControls] : []),
    ],
    content: [list],
    footer: [tripModeButton()],
  })
  clearStatus()
  setViewBack(resumeDestinationSelection)
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
    const variant = await mapApi.routeVariant(activeCity!.code, leg.routeName, leg.variantKey)
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
  if (fitCamera && bounds.isValid()) camera.focusBounds(bounds, { maxZoom: 16 })
  return true
}

async function previewDirectRoutes(directRoutes: DirectRoute[], { fitCamera }: JourneyPreviewOptions): Promise<boolean> {
  if (!activeCity) return false
  const selectedIndex = normalizeDirectIndex(directRoutes)
  selectedDirectIndex = selectedIndex
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(selectDirectPreviewEntries(directRoutes, selectedIndex).map(async ({ route, index }) => {
    const variant = await mapApi.routeVariant(activeCity!.code, route.routeName, route.variantKey)
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
  if (fitCamera && bounds.isValid()) camera.focusBounds(bounds, { maxZoom: 16 })
  return true
}

async function previewPlaceRoutes(placeRoutes: PlaceRoute[], place: NearbyPlace) {
  if (!activeCity) return
  const requestId = ++previewRequest
  previewLayer.clearLayers()
  const previews = await Promise.all(placeRoutes.slice(0, 8).map(async (route) => {
    const variant = await mapApi.routeVariant(activeCity!.code, route.routeName, route.variantKey)
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
  const selected = options.selected !== false
  const { line: fullLine, target: fullLineTarget } = bindSelectableLine(variant.shape, 'routePreviewPane', previewLayer, {
    color, weight: selected ? 3.5 : 2.5, opacity: selected ? .18 : .08, lineCap: 'round', lineJoin: 'round',
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
        weight: selected ? 7 : 4,
        opacity: selected ? .92 : .26,
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

  if (board && alight && selected) {
    addPreviewStopDots(variant.stops, color, previewLayer)
    ;[[board, labels[0]], [alight, labels[1]]].forEach(([stop, label]) => {
      const feature = stop as typeof board
      const [longitude, latitude] = feature.geometry.coordinates
      bindTextTooltip(
        unifiedStopMarker([latitude, longitude], true, color),
        `${label} · ${feature.properties.stopName}`,
        { permanent: true, direction: 'top' },
      ).addTo(previewLayer)
    })
  }
  return { fullLine, segmentLine, focusBounds, hasSegment: Boolean(segmentLine) }
}

async function openPlaceById(placeId: string) {
  if (!activeCity) return
  const place = await mapApi.place(activeCity.code, placeId)
  camera.focusPoint([place.latitude, place.longitude], 16)
  lastNearbyOrigin = [place.latitude, place.longitude]
  lastNearbyPlaces = [place]
  interactionMode = 'nearby'
  await showPlaceRoutes(place)
}

function writeTripResultsUrl() {
  if (!activeCity || !selectedFrom || !selectedTo) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  const snapshot: TripResultsHistorySnapshot = {
    city: activeCity.code,
    from: selectedFrom,
    to: selectedTo,
    fromCoordinate,
    toCoordinate,
    directRoutes: lastDirectRoutes,
    transferPlans: lastTransferPlans,
    selectedDirectIndex,
    selectedTransferIndex,
  }
  history.replaceState({
    ...currentState,
    mapView: 'trip-results',
    tripResults: snapshot,
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&trip=results&from=${encodeURIComponent(selectedFrom.placeId)}&to=${encodeURIComponent(selectedTo.placeId)}`)
  setDocumentTitle(`${selectedFrom?.name ?? '出發地'} → ${selectedTo?.name ?? '目的地'}`)
}

function restoreTripResultsState(): boolean {
  if (!activeCity) return false
  const snapshot = history.state?.tripResults as TripResultsHistorySnapshot | undefined
  if (!snapshot || snapshot.city !== activeCity.code || !snapshot.from || !snapshot.to) return false
  selectedFrom = snapshot.from
  selectedTo = snapshot.to
  fromCoordinate = snapshot.fromCoordinate
  toCoordinate = snapshot.toCoordinate
  lastDirectRoutes = Array.isArray(snapshot.directRoutes) ? snapshot.directRoutes : []
  lastTransferPlans = Array.isArray(snapshot.transferPlans) ? snapshot.transferPlans : []
  selectedDirectIndex = Number.isInteger(snapshot.selectedDirectIndex) ? snapshot.selectedDirectIndex : 0
  selectedTransferIndex = Number.isInteger(snapshot.selectedTransferIndex) ? snapshot.selectedTransferIndex : 0
  tripStage = 'idle'
  interactionMode = 'trip-results'
  return Boolean(lastDirectRoutes.length || lastTransferPlans.length)
}

async function restoreSharedTripResults(params: URLSearchParams): Promise<boolean> {
  if (!activeCity) return false
  const fromPlaceId = params.get('from')
  const toPlaceId = params.get('to')
  if (!fromPlaceId || !toPlaceId || fromPlaceId === toPlaceId) return false
  const [from, to] = await Promise.all([
    mapApi.place(activeCity.code, fromPlaceId),
    mapApi.place(activeCity.code, toPlaceId),
  ])
  selectedFrom = from
  selectedTo = to
  fromCoordinate = [from.latitude, from.longitude]
  toCoordinate = [to.latitude, to.longitude]
  lastDirectRoutes = []
  lastTransferPlans = []
  selectedDirectIndex = 0
  selectedTransferIndex = 0
  tripStage = 'idle'
  interactionMode = 'trip-results'
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'trip-results', mapParent: 'catalogue' }, '', location.href)
  await loadDirectRoutes()
  return true
}

async function openNearbyPlace(place: NearbyPlace) {
  if (!activeCity) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.pushState({
    ...currentState,
    mapView: 'place',
    mapParent: 'nearby',
  }, '', `/map?city=${encodeURIComponent(activeCity.code)}&place=${encodeURIComponent(place.placeId)}`)
  await showPlaceRoutes(place)
}

function returnToNearbyPlaces() {
  if (history.state?.mapView === 'place' && history.state?.mapParent) {
    history.back()
    return
  }
  renderNearbyPlaces()
}

function placeBackLabel(): string {
  return history.state?.mapParent === 'catalogue' ? '返回路線列表' : '附近站牌'
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
    control.textContent = '⌂'
    control.title = selected ? '從首頁移除這個方向' : '將這個方向加入首頁'
    control.setAttribute('aria-label', control.title)
    control.setAttribute('aria-pressed', String(selected))
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
  renderDrawer({
    mode: 'map-list',
    header: [
      drawerBack(placeBackLabel(), returnToNearbyPlaces),
      heading(place.name, '正在取得路線與到站時間'),
    ],
    content: [loadingList],
  })
  setViewBack(returnToNearbyPlaces)
  setStatus(`正在讀取 ${place.name} 的路線…`)
  const { requestId, signal } = beginNavRequest()
  try {
    const arrivals = await mapApi.placeRoutes(activeCity.code, place.placeId, signal)
    if (placeRequest !== previewRequest || isStaleNav(requestId)) return
    const placeRoutes = arrivals.routes
    const frequency = new Map<string, number>()
    readBoards().flatMap((board) => board.buses).forEach((bus) => {
      const routeUid = typeof bus.routeUid === 'string' ? bus.routeUid : ''
      if (routeUid) frequency.set(routeUid, (frequency.get(routeUid) ?? 0) + 1)
    })
    const sortedRoutes = [...placeRoutes].sort((a, b) =>
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
      const tick = document.createElement('span')
      tick.className = 'route-color-tick'
      tick.setAttribute('aria-hidden', 'true')
      const line = document.createElement('span')
      line.className = 'place-route-main'
      const routeName = document.createElement('strong')
      routeName.textContent = route.routeName
      const eta = etaPresentationNode(route.etaLabel)
      eta.classList.add('place-route-eta')
      if (route.source === 'schedule') eta.classList.add('estimated')
      if ((route.source === 'realtime' || route.source === 'stale-realtime')
        && route.estimateSeconds !== null
        && route.estimateSeconds <= 180) {
        eta.classList.add('urgent')
      }
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
      button.appendChild(tick)
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
    renderDrawer({
      mode: 'map-list',
      header: [
        drawerBack(placeBackLabel(), returnToNearbyPlaces),
        heading(place.name, `${place.distanceMeters > 0 ? `${Math.round(place.distanceMeters)} 公尺 · ` : ''}${placeRoutes.length} 個行車方向`),
      ],
      content: [
        ...(arrivals.warning
          ? [degradedNotice(tdxWarningMessages[arrivals.warning], () => void showPlaceRoutes(place))]
          : []),
        list,
      ],
    })
    await previewPlaceRoutes(sortedRoutes, place)
    if (!activeCity || isStaleNav(requestId)) return
    drawTripEndpoints()
    camera.focusPoint([place.latitude, place.longitude], map.getZoom())
    const currentState = history.state && typeof history.state === 'object' ? history.state : {}
    history.replaceState({ ...currentState, mapView: 'place' }, '', `/map?city=${activeCity.code}&place=${encodeURIComponent(place.placeId)}`)
    setDocumentTitle(`${place.name} 到站時間`)
    clearStatus()
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '站牌路線讀取失敗'
    const credentialRejected = isTdxTokenRejectedError(error)
    setStatus(message, true)
    renderDrawer({
      mode: 'map-list',
      header: [
        drawerBack(placeBackLabel(), returnToNearbyPlaces),
        heading(place.name, message),
      ],
      content: [degradedNotice(message, () => void showPlaceRoutes(place), credentialRejected)],
    })
  }
}

function degradedNotice(message: string, onRetry: () => void, credentialRecovery = false): HTMLElement {
  const notice = document.createElement('section')
  notice.className = 'degraded-notice'
  if (credentialRecovery) notice.classList.add('credential-recovery')
  notice.setAttribute('role', 'status')
  notice.appendChild(paragraph(message))
  const actions = document.createElement('div')
  actions.className = 'degraded-actions'
  actions.appendChild(retryButton(onRetry))
  const setup = document.createElement('a')
  setup.className = 'quiet-link'
  setup.href = '/setup'
  setup.textContent = '檢查 TDX 設定'
  actions.appendChild(setup)
  notice.appendChild(actions)
  return notice
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

function etaPresentationNode(label: string): HTMLSpanElement {
  const parts = splitEtaLabel(label)
  const node = document.createElement('span')
  if (parts.prefix) {
    const prefix = document.createElement('small')
    prefix.className = 'eta-prefix'
    prefix.textContent = parts.prefix
    node.appendChild(prefix)
  }
  const value = document.createElement('b')
  value.className = 'eta-value'
  value.textContent = parts.value
  node.appendChild(value)
  if (parts.suffix) {
    const suffix = document.createElement('small')
    suffix.className = 'eta-suffix'
    suffix.textContent = parts.suffix
    node.appendChild(suffix)
  }
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

function buttonGrid(items: Array<{ label: string; onClick: () => void }>, className?: string): HTMLElement {
  const grid = document.createElement('div')
  grid.className = 'selection-grid'
  if (className) grid.classList.add(className)
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
  statusNode.classList.remove('dismissed')
  statusNode.classList.toggle('error', error)
  statusNode.removeAttribute('aria-hidden')
}

function clearStatus() {
  statusNode.textContent = ''
  statusNode.classList.add('dismissed')
  statusNode.classList.remove('error')
  statusNode.setAttribute('aria-hidden', 'true')
}

// 跟著畫面更新分頁標題:多分頁與瀏覽紀錄裡才認得出「哪一條路線、哪一站」。
function setDocumentTitle(prefix?: string) {
  document.title = prefix ? `${prefix}｜Mochi Bus` : '公車地圖｜Mochi Bus'
}

function fitRegionCities(region: (typeof regions)[number], regionCities: MapCity[]) {
  const bounds = L.latLngBounds([])
  regionCities.forEach((city) => bounds.extend(city.center))
  if (!bounds.isValid()) {
    camera.focusPoint(region.center, overviewMaxZoom(region.maxZoom))
    return
  }
  camera.focusBounds(bounds, { maxZoom: () => overviewMaxZoom(region.maxZoom) })
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}
