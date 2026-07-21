from pathlib import Path
import re


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{label}: expected one match, found {count}')
    return text.replace(old, new, 1)


main_path = Path('web/map/main.ts')
main = main_path.read_text()
main = replace_once(
    main,
    "import { createNearbyPlacesController } from './nearby-places-controller'\nimport { createNearbyPlacesView } from './nearby-places-view'",
    "import { createNearbyPlacesController } from './nearby-places-controller'\nimport { createNearbyPlacesMap } from './nearby-places-map'\nimport { createNearbyPlacesView } from './nearby-places-view'",
    'Nearby map import',
)
main = replace_once(
    main,
    "const journeyPreviewMap = createJourneyPreviewMap({ map, layer: previewLayer, hoverCapable })\nconst nearbyLayer = L.layerGroup().addTo(map)\nconst networkLayer = L.layerGroup().addTo(map)",
    "const journeyPreviewMap = createJourneyPreviewMap({ map, layer: previewLayer, hoverCapable })\nconst nearbyLayer = L.layerGroup().addTo(map)\nconst nearbyPlacesMap = createNearbyPlacesMap({\n  layer: nearbyLayer,\n  hoverCapable,\n  createStopMarker: unifiedStopMarker,\n  onOpenPlace: openNearbyPlace,\n})\nconst networkLayer = L.layerGroup().addTo(map)",
    'Nearby map construction',
)
main = replace_once(
    main,
    "    nearbyPlacesView.renderLoading({ cityCode, origin, backLabel: '附近站牌', onBack: renderNearbyPlaces })\n    nearbyLayer.clearLayers()\n    lastNearbyOrigin = [...origin]\n    unifiedStopMarker([...origin], true, stopFillAccent).addTo(nearbyLayer)\n    setStatus('正在找這附近的站牌…')",
    "    nearbyPlacesView.renderLoading({ cityCode, origin, backLabel: '附近站牌', onBack: renderNearbyPlaces })\n    lastNearbyOrigin = [...origin]\n    nearbyPlacesMap.renderLoadingOrigin(origin)\n    setStatus('正在找這附近的站牌…')",
    'Nearby loading drawing',
)
main = replace_once(
    main,
    "  nearbyLayer.clearLayers()\n  const origin = unifiedStopMarker(lastNearbyOrigin, true, stopFillAccent).addTo(nearbyLayer)\n  bindHoverTooltip(origin, '你點的位置')\n\n  for (const place of lastNearbyPlaces) {\n    bindHoverTooltip(unifiedStopMarker([place.latitude, place.longitude], true), `${place.name} · ${Math.round(place.distanceMeters)} m`)\n      .on('click', (event) => {\n        L.DomEvent.stopPropagation(event)\n        void openNearbyPlace(place)\n      })\n      .addTo(nearbyLayer)\n  }",
    "  nearbyPlacesMap.renderPlaces(lastNearbyOrigin, lastNearbyPlaces)",
    'Nearby place drawing',
)
main_path.write_text(main)

map_source = """import L from 'leaflet'\nimport { bindTextTooltip } from './leaflet-tooltip'\nimport type { NearbyPlace } from './map-api-client'\nimport type { NearbyOrigin } from './nearby-places-view'\nimport { stopFillAccent } from './theme'\n\ntype NearbyPlacesMapOptions = {\n  layer: L.LayerGroup\n  hoverCapable: boolean\n  createStopMarker: (\n    position: L.LatLngExpression,\n    prominent?: boolean,\n    fillColor?: string,\n  ) => L.CircleMarker\n  onOpenPlace: (place: NearbyPlace) => void | Promise<void>\n}\n\nexport type NearbyPlacesMap = {\n  renderLoadingOrigin(origin: NearbyOrigin): void\n  renderPlaces(origin: NearbyOrigin, places: readonly NearbyPlace[]): void\n}\n\n// Leaflet-only Nearby Places surface. Request lifecycle, Drawer presentation, History,\n// status, Trip state, camera behavior and place navigation remain in the app shell.\nexport function createNearbyPlacesMap(options: NearbyPlacesMapOptions): NearbyPlacesMap {\n  function bindHoverTooltip<T extends L.Layer>(layer: T, text: string): T {\n    if (options.hoverCapable) bindTextTooltip(layer, text)\n    return layer\n  }\n\n  function createOriginMarker(origin: NearbyOrigin): L.CircleMarker {\n    return options.createStopMarker([...origin], true, stopFillAccent)\n  }\n\n  return {\n    renderLoadingOrigin(origin) {\n      options.layer.clearLayers()\n      createOriginMarker(origin).addTo(options.layer)\n    },\n\n    renderPlaces(origin, places) {\n      options.layer.clearLayers()\n      const originMarker = createOriginMarker(origin).addTo(options.layer)\n      bindHoverTooltip(originMarker, '你點的位置')\n\n      for (const place of places) {\n        bindHoverTooltip(\n          options.createStopMarker([place.latitude, place.longitude], true),\n          `${place.name} · ${Math.round(place.distanceMeters)} m`,\n        )\n          .on('click', (event) => {\n            L.DomEvent.stopPropagation(event)\n            void options.onOpenPlace(place)\n          })\n          .addTo(options.layer)\n      }\n    },\n  }\n}\n"""
Path('web/map/nearby-places-map.ts').write_text(map_source)

map_test = """import { beforeEach, describe, expect, it, vi } from 'vitest'\nimport type L from 'leaflet'\nimport type { NearbyPlace } from './map-api-client'\nimport type { NearbyOrigin } from './nearby-places-view'\n\nconst mocks = vi.hoisted(() => ({\n  bindTextTooltip: vi.fn((layer) => layer),\n  stopPropagation: vi.fn(),\n}))\n\nvi.mock('leaflet', () => ({\n  default: { DomEvent: { stopPropagation: mocks.stopPropagation } },\n}))\nvi.mock('./leaflet-tooltip', () => ({ bindTextTooltip: mocks.bindTextTooltip }))\n\nimport { createNearbyPlacesMap } from './nearby-places-map'\nimport { stopFillAccent } from './theme'\n\nclass FakeLayerGroup {\n  markers: FakeMarker[] = []\n  clearLayers = vi.fn(() => {\n    this.markers = []\n    return this\n  })\n}\n\nclass FakeMarker {\n  private readonly listeners = new Map<string, (event: unknown) => void>()\n\n  constructor(\n    readonly position: L.LatLngExpression,\n    readonly prominent: boolean | undefined,\n    readonly fillColor: string | undefined,\n  ) {}\n\n  addTo(layer: FakeLayerGroup): this {\n    layer.markers.push(this)\n    return this\n  }\n\n  on(type: string, listener: (event: unknown) => void): this {\n    this.listeners.set(type, listener)\n    return this\n  }\n\n  fire(type: string, event: unknown): void {\n    this.listeners.get(type)?.(event)\n  }\n}\n\nfunction place(index: number, distanceMeters: number): NearbyPlace {\n  return {\n    placeId: `P${index}`,\n    name: `Place ${index}`,\n    latitude: 25 + index / 1000,\n    longitude: 121 + index / 1000,\n    distanceMeters,\n  }\n}\n\nfunction createHarness(hoverCapable = true) {\n  const layer = new FakeLayerGroup()\n  const markers: FakeMarker[] = []\n  const createStopMarker = vi.fn((position, prominent, fillColor) => {\n    const marker = new FakeMarker(position, prominent, fillColor)\n    markers.push(marker)\n    return marker as unknown as L.CircleMarker\n  })\n  const onOpenPlace = vi.fn()\n  const mapSurface = createNearbyPlacesMap({\n    layer: layer as unknown as L.LayerGroup,\n    hoverCapable,\n    createStopMarker,\n    onOpenPlace,\n  })\n  return { layer, markers, createStopMarker, onOpenPlace, mapSurface }\n}\n\nconst origin: NearbyOrigin = [25.01234, 121.56789]\n\nbeforeEach(() => {\n  vi.clearAllMocks()\n})\n\ndescribe('Nearby places map', () => {\n  it('clears the layer and renders the loading origin with the accent style', () => {\n    const harness = createHarness()\n\n    harness.mapSurface.renderLoadingOrigin(origin)\n\n    expect(harness.layer.clearLayers).toHaveBeenCalledOnce()\n    expect(harness.createStopMarker).toHaveBeenCalledWith([...origin], true, stopFillAccent)\n    expect(harness.layer.markers).toEqual([harness.markers[0]])\n    expect(mocks.bindTextTooltip).not.toHaveBeenCalled()\n  })\n\n  it('renders origin and place markers with rounded hover labels', () => {\n    const harness = createHarness()\n    const places = [place(1, 120.4), place(2, 48.7)]\n\n    harness.mapSurface.renderPlaces(origin, places)\n\n    expect(harness.layer.markers).toHaveLength(3)\n    expect(harness.createStopMarker).toHaveBeenNthCalledWith(1, [...origin], true, stopFillAccent)\n    expect(harness.createStopMarker).toHaveBeenNthCalledWith(2, [places[0].latitude, places[0].longitude], true)\n    expect(harness.createStopMarker).toHaveBeenNthCalledWith(3, [places[1].latitude, places[1].longitude], true)\n    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(1, harness.markers[0], '你點的位置')\n    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(2, harness.markers[1], 'Place 1 · 120 m')\n    expect(mocks.bindTextTooltip).toHaveBeenNthCalledWith(3, harness.markers[2], 'Place 2 · 49 m')\n  })\n\n  it('stops map propagation and delegates the selected place', () => {\n    const harness = createHarness()\n    const selected = place(1, 120)\n    const event = { type: 'click' }\n    harness.mapSurface.renderPlaces(origin, [selected])\n\n    harness.markers[1].fire('click', event)\n\n    expect(mocks.stopPropagation).toHaveBeenCalledWith(event)\n    expect(harness.onOpenPlace).toHaveBeenCalledWith(selected)\n  })\n\n  it('omits hover tooltips when the device cannot hover', () => {\n    const harness = createHarness(false)\n\n    harness.mapSurface.renderPlaces(origin, [place(1, 120)])\n\n    expect(mocks.bindTextTooltip).not.toHaveBeenCalled()\n    expect(harness.layer.markers).toHaveLength(2)\n  })\n})\n"""
Path('web/map/nearby-places-map.test.ts').write_text(map_test)

size_path = Path('web/map/main-size.test.ts')
size = size_path.read_text()
size = replace_once(
    size,
    "import nearbyPlacesSource from './nearby-places-controller.ts?raw'\nimport nearbyPlacesViewSource from './nearby-places-view.ts?raw'",
    "import nearbyPlacesSource from './nearby-places-controller.ts?raw'\nimport nearbyPlacesMapSource from './nearby-places-map.ts?raw'\nimport nearbyPlacesViewSource from './nearby-places-view.ts?raw'",
    'Nearby map raw import',
)
map_boundary_test = """\n  it('delegates Nearby Places Leaflet drawing to the Nearby places map surface', () => {\n    expect(mainSource).toContain('createNearbyPlacesMap')\n    expect(mainSource).toContain('nearbyPlacesMap.renderLoadingOrigin(origin)')\n    expect(mainSource).toContain('nearbyPlacesMap.renderPlaces(lastNearbyOrigin, lastNearbyPlaces)')\n    expect(mainSource).not.toContain("bindHoverTooltip(origin, '你點的位置')")\n    expect(mainSource).not.toContain('Math.round(place.distanceMeters)')\n    expect(nearbyPlacesMapSource).toContain("bindHoverTooltip(originMarker, '你點的位置')")\n    expect(nearbyPlacesMapSource).toContain('Math.round(place.distanceMeters)')\n    expect(nearbyPlacesMapSource).toContain('L.DomEvent.stopPropagation(event)')\n    expect(nearbyPlacesMapSource).toContain('options.onOpenPlace(place)')\n    for (const dependency of [\n      'history.', 'document.', 'window.', 'mapApi.', 'camera.', 'trip.', 'routeDetail',\n      'cityNetwork', 'beginNavRequest', 'isStaleNav', 'setStatus(', 'clearStatus(',\n      'setDocumentTitle', 'historyRecord', 'readMapView', 'mapViewFromUrl',\n      'findNearbyPlaces', 'renderNearbyPlaces', './main',\n    ]) expect(nearbyPlacesMapSource).not.toContain(dependency)\n  })\n"""
anchor = "\n  it('delegates Nearby Places Drawer presentation to the Nearby places view', () => {"
size = replace_once(size, anchor, map_boundary_test + anchor, 'Nearby map architecture test')
line_count = len(main.splitlines()) + 1
size = re.sub(
    r'const MAP_MAIN_LINE_LIMIT = \d+',
    f'const MAP_MAIN_LINE_LIMIT = {line_count}',
    size,
    count=1,
)
size_path.write_text(size)

print(f'main.ts line lock: {line_count}')
