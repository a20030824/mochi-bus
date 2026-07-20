from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

main_path = Path('web/map/main.ts')
main = main_path.read_text()
main = replace_once(
    main,
    "import { createNearbyPlacesView } from './nearby-places-view'\n",
    "import {\n"
    "  createNearbyPlacesController,\n"
    "  type NearbyPlacesController,\n"
    "  type NearbyPlacesFailure,\n"
    "  type NearbyPlacesPresentation,\n"
    "  type NearbyPlacesRequest,\n"
    "} from './nearby-places-controller'\n"
    "import { createNearbyPlacesView } from './nearby-places-view'\n",
    'nearby controller import',
)

old_view = """const nearbyPlacesView = createNearbyPlacesView({
  renderDrawer,
  createBackButton: drawerBack,
  createHeading: heading,
  createRetryButton: retryButton,
  createTripModeButton: tripModeButton,
  onOpenPlace: (place) => void openNearbyPlace(place),
})
"""
new_view = old_view + """let nearbyPlaces!: NearbyPlacesController
nearbyPlaces = createNearbyPlacesController({
  currentCityCode: () => activeCity?.code,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  loadNearby: mapApi.nearby,
  onStart: prepareNearbyPlacesLoad,
  onPlaces: presentNearbyPlaces,
  onAutoPreview: (place) => openNearbyPlace(place),
  onError: presentNearbyPlacesError,
})
"""
main = replace_once(main, old_view, new_view, 'nearby controller construction')

old_flow = """async function findNearbyPlaces(
  latitude: number,
  longitude: number,
  autoPreview = false,
  historyMode: 'push' | 'replace' = 'push',
) {
  if (!activeCity) return
  if (historyMode === 'push') cancelLocationHydration()
  const currentState = historyRecord()
  const currentView = readMapView(currentState) ?? mapViewFromUrl()
  const nearbyState = {
    ...currentState,
    mapView: 'nearby',
    mapParent: currentView === 'nearby'
      ? readMapView({ mapView: currentState.mapParent }) ?? 'catalogue'
      : currentView,
  }
  const nearbyUrl = `/map?city=${encodeURIComponent(activeCity.code)}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`
  if (historyMode === 'push' && currentView !== 'nearby') history.pushState(nearbyState, '', nearbyUrl)
  else history.replaceState(nearbyState, '', nearbyUrl)
  cityNetwork.hide()
  // 只有「選點進行中」需要中止規劃;已有行程結果就保留,
  // 點站牌不再把整趟規劃清掉,附近站牌視圖會給「返回行程候選」的退路。
  if (interactionMode === 'trip') clearTripState()
  interactionMode = 'nearby'
  clearPreviewLayer()
  routeDetail.close()
  nearbyPlacesView.renderLoading({
    cityCode: activeCity.code,
    origin: [latitude, longitude],
    backLabel: '附近站牌',
    onBack: renderNearbyPlaces,
  })
  nearbyLayer.clearLayers()
  lastNearbyOrigin = [latitude, longitude]
  const city = activeCity
  const radius = map.getZoom() >= 15 ? 300 : 500
  unifiedStopMarker([latitude, longitude], true, stopFillAccent).addTo(nearbyLayer)
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
    const message = nearbyPlacesView.renderError({
      cityCode: city.code,
      origin: [latitude, longitude],
      error,
      backLabel: '附近站牌',
      onBack: renderNearbyPlaces,
      onRetry: () => void findNearbyPlaces(latitude, longitude, autoPreview, 'replace'),
    })
    setStatus(message, true)
  }
}

function renderNearbyPlaces() {
  if (!activeCity || !lastNearbyOrigin) return
  cancelNavRequest()
  nearbyLayer.clearLayers()
  const origin = unifiedStopMarker(lastNearbyOrigin, true, stopFillAccent).addTo(nearbyLayer)
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

  const managedNearbyParent = history.state?.mapView === 'nearby' && history.state?.mapParent
  const nearbyBack = managedNearbyParent
    ? () => history.back()
    : hasTripResults() ? returnToTripResults : renderRoutePicker
  const nearbyBackLabel = history.state?.mapParent === 'route'
    ? '返回路線'
    : hasTripResults() ? '返回行程候選' : '路線列表'
  nearbyPlacesView.renderPlaces({
    cityCode: activeCity.code,
    origin: lastNearbyOrigin,
    places: lastNearbyPlaces,
    backLabel: nearbyBackLabel,
    onBack: nearbyBack,
  })
  clearStatus()
  const [latitude, longitude] = lastNearbyOrigin
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'nearby' }, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
  setDocumentTitle(`${activeCity.name}公車地圖`)
}
"""

new_flow = """async function findNearbyPlaces(
  latitude: number,
  longitude: number,
  autoPreview = false,
  historyMode: 'push' | 'replace' = 'push',
) {
  if (!activeCity) return
  if (historyMode === 'push') cancelLocationHydration()
  const currentState = historyRecord()
  const currentView = readMapView(currentState) ?? mapViewFromUrl()
  const nearbyState = {
    ...currentState,
    mapView: 'nearby',
    mapParent: currentView === 'nearby'
      ? readMapView({ mapView: currentState.mapParent }) ?? 'catalogue'
      : currentView,
  }
  const nearbyUrl = `/map?city=${encodeURIComponent(activeCity.code)}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`
  if (historyMode === 'push' && currentView !== 'nearby') history.pushState(nearbyState, '', nearbyUrl)
  else history.replaceState(nearbyState, '', nearbyUrl)
  cityNetwork.hide()
  // 只有「選點進行中」需要中止規劃;已有行程結果就保留,
  // 點站牌不再把整趟規劃清掉,附近站牌視圖會給「返回行程候選」的退路。
  if (interactionMode === 'trip') clearTripState()
  interactionMode = 'nearby'
  clearPreviewLayer()
  routeDetail.close()
  await nearbyPlaces.load({
    cityCode: activeCity.code,
    origin: [latitude, longitude],
    radiusMeters: map.getZoom() >= 15 ? 300 : 500,
    autoPreview,
  })
}

function prepareNearbyPlacesLoad({ cityCode, origin }: NearbyPlacesRequest): void {
  nearbyPlacesView.renderLoading({
    cityCode,
    origin,
    backLabel: '附近站牌',
    onBack: renderNearbyPlaces,
  })
  nearbyLayer.clearLayers()
  lastNearbyOrigin = [...origin]
  unifiedStopMarker(origin, true, stopFillAccent).addTo(nearbyLayer)
  setStatus('正在找這附近的站牌…')
}

function presentNearbyPlaces({ places }: NearbyPlacesPresentation): void {
  lastNearbyPlaces = places
  renderNearbyPlaces(false)
}

function presentNearbyPlacesError({ cityCode, origin, error }: NearbyPlacesFailure): void {
  const message = nearbyPlacesView.renderError({
    cityCode,
    origin,
    error,
    backLabel: '附近站牌',
    onBack: renderNearbyPlaces,
    onRetry: () => void nearbyPlaces.retry(),
  })
  setStatus(message, true)
}

function renderNearbyPlaces(cancelRequest = true) {
  if (!activeCity || !lastNearbyOrigin) return
  if (cancelRequest) {
    nearbyPlaces.cancel()
    cancelNavRequest()
  }
  nearbyLayer.clearLayers()
  const origin = unifiedStopMarker(lastNearbyOrigin, true, stopFillAccent).addTo(nearbyLayer)
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

  const managedNearbyParent = history.state?.mapView === 'nearby' && history.state?.mapParent
  const nearbyBack = managedNearbyParent
    ? () => history.back()
    : hasTripResults() ? returnToTripResults : renderRoutePicker
  const nearbyBackLabel = history.state?.mapParent === 'route'
    ? '返回路線'
    : hasTripResults() ? '返回行程候選' : '路線列表'
  nearbyPlacesView.renderPlaces({
    cityCode: activeCity.code,
    origin: lastNearbyOrigin,
    places: lastNearbyPlaces,
    backLabel: nearbyBackLabel,
    onBack: nearbyBack,
  })
  clearStatus()
  const [latitude, longitude] = lastNearbyOrigin
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'nearby' }, '', `/map?city=${activeCity.code}&lat=${latitude.toFixed(5)}&lon=${longitude.toFixed(5)}`)
  setDocumentTitle(`${activeCity.name}公車地圖`)
}
"""
main = replace_once(main, old_flow, new_flow, 'nearby loading flow')
main_path.write_text(main)

size_path = Path('web/map/main-size.test.ts')
size = size_path.read_text()
size = replace_once(
    size,
    "import placeRoutesViewSource from './place-routes-view.ts?raw'\nimport nearbyPlacesViewSource from './nearby-places-view.ts?raw'\n",
    "import placeRoutesViewSource from './place-routes-view.ts?raw'\n"
    "import nearbyPlacesSource from './nearby-places-controller.ts?raw'\n"
    "import nearbyPlacesViewSource from './nearby-places-view.ts?raw'\n",
    'architecture import',
)

anchor = """  it('delegates Nearby Places Drawer presentation to the Nearby places view', () => {
"""
controller_test = """  it('delegates Nearby Places loading and request lifecycle to the Nearby places controller', () => {
    expect(mainSource).toContain('createNearbyPlacesController')
    expect(mainSource).toContain('await nearbyPlaces.load({')
    expect(mainSource).toContain('nearbyPlaces.retry()')
    expect(mainSource).toContain('nearbyPlaces.cancel()')
    expect(mainSource).not.toContain('await mapApi.nearby(')
    expect(mainSource).not.toContain('places.slice(0, 12)')
    expect(nearbyPlacesSource).toContain('loaded.slice(0, placeLimit)')
    expect(nearbyPlacesSource).toContain('options.onAutoPreview(')
    expect(nearbyPlacesSource).toContain('options.onError({ ...request, error })')
    expect(nearbyPlacesSource).toContain('options.currentCityCode() === cityCode')
    expect(nearbyPlacesSource).toContain('!options.isStaleRequest(requestId)')
    for (const dependency of [
      'leaflet', 'history.', 'document.', 'window.', 'mapApi.', 'camera.', 'trip.',
      'routeDetail', 'cityNetwork', 'nearbyLayer', 'setStatus(', 'clearStatus(',
      'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',
      'openNearbyPlace', 'findNearbyPlaces', 'renderNearbyPlaces', './main',
    ]) expect(nearbyPlacesSource).not.toContain(dependency)
  })

"""
size = replace_once(size, anchor, controller_test + anchor, 'architecture controller test')
line_count = len(main.splitlines())
import re
size, count = re.subn(r'const MAP_MAIN_LINE_LIMIT = \d+', f'const MAP_MAIN_LINE_LIMIT = {line_count}', size, count=1)
if count != 1:
    raise RuntimeError('line limit: expected one replacement')
size_path.write_text(size)
print(f'main.ts lines: {line_count}')
