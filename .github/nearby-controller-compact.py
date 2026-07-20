from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)

main_path = Path('web/map/main.ts')
main = main_path.read_text()
main = replace_once(
    main,
    """import {
  createNearbyPlacesController,
  type NearbyPlacesController,
  type NearbyPlacesFailure,
  type NearbyPlacesPresentation,
  type NearbyPlacesRequest,
} from './nearby-places-controller'
""",
    "import { createNearbyPlacesController } from './nearby-places-controller'\n",
    'controller import',
)
main = replace_once(
    main,
    """let nearbyPlaces!: NearbyPlacesController
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
""",
    """const nearbyPlaces = createNearbyPlacesController({
  currentCityCode: () => activeCity?.code,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  loadNearby: mapApi.nearby,
  onStart: ({ cityCode, origin }) => {
    nearbyPlacesView.renderLoading({ cityCode, origin, backLabel: '附近站牌', onBack: renderNearbyPlaces })
    nearbyLayer.clearLayers()
    lastNearbyOrigin = [...origin]
    unifiedStopMarker(origin, true, stopFillAccent).addTo(nearbyLayer)
    setStatus('正在找這附近的站牌…')
  },
  onPlaces: ({ places }) => { lastNearbyPlaces = places; renderNearbyPlaces() },
  onAutoPreview: openNearbyPlace,
  onError: ({ cityCode, origin, error }) => setStatus(nearbyPlacesView.renderError({
    cityCode, origin, error, backLabel: '附近站牌', onBack: renderNearbyPlaces,
    onRetry: () => void nearbyPlaces.retry(),
  }), true),
})
""",
    'controller construction',
)
main = replace_once(
    main,
    """function prepareNearbyPlacesLoad({ cityCode, origin }: NearbyPlacesRequest): void {
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
""",
    """function renderNearbyPlaces() {
  if (!activeCity || !lastNearbyOrigin) return
  nearbyPlaces.cancel()
  cancelNavRequest()
""",
    'shell callbacks',
)
main_path.write_text(main)

size_path = Path('web/map/main-size.test.ts')
size = size_path.read_text()
line_count = len(main.replace('\r\n', '\n').split('\n'))
size, count = re.subn(r'const MAP_MAIN_LINE_LIMIT = \d+', f'const MAP_MAIN_LINE_LIMIT = {line_count}', size, count=1)
if count != 1:
    raise RuntimeError('line limit: expected one replacement')
size_path.write_text(size)
print(f'main.ts lines: {line_count}')
