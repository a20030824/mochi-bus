from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    file = Path(path)
    text = file.read_text()
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{path}: expected exactly one anchor, found {count}')
    file.write_text(text.replace(old, new, 1))


replace_once(
    'src/domain/map/camera-padding.ts',
    'type RectSize = { width: number; height: number }',
    '''export function cameraPanOffset(padding: CameraPadding): [number, number] {
  const [left, top] = padding.paddingTopLeft
  const [right, bottom] = padding.paddingBottomRight
  return [
    (nonNegativeFinite(right, 0) - nonNegativeFinite(left, 0)) / 2,
    (nonNegativeFinite(bottom, 0) - nonNegativeFinite(top, 0)) / 2,
  ]
}

type RectSize = { width: number; height: number }''',
)
replace_once(
    'src/domain/map/camera-padding.test.ts',
    '  calculateCameraPadding,\n  DEFAULT_CAMERA_PADDING_OPTIONS,',
    '  calculateCameraPadding,\n  cameraPanOffset,\n  DEFAULT_CAMERA_PADDING_OPTIONS,',
)
test_marker = "  it('treats the bottom-sheet threshold as inclusive and the value just below it as a side panel', () => {"
replace_once(
    'src/domain/map/camera-padding.test.ts',
    test_marker,
    '''  it('converts drawer padding into the pan needed to center a point in the visible map', () => {
    const desktop = calculateCameraPadding(
      rect(0, 0, 1440, 900),
      rect(1022, 400, 1422, 882),
    )
    const mobile = calculateCameraPadding(
      rect(0, 0, 390, 844),
      rect(10, 481, 380, 834),
    )

    expect(cameraPanOffset(desktop)).toEqual([210.5, -22.5])
    expect(cameraPanOffset(mobile)).toEqual([0, 160.5])
  })

''' + test_marker,
)
replace_once(
    'web/map/main.ts',
    "import { calculateCameraPadding, type CameraRect } from '../../src/domain/map/camera-padding'",
    "import { calculateCameraPadding, cameraPanOffset, type CameraRect } from '../../src/domain/map/camera-padding'",
)
replace_once('web/map/main.ts', '  map.setView(region.center, region.zoom)\n', '')
replace_once(
    'web/map/main.ts',
    '  )\n  setViewBack(showTaiwan)\n}\n\nasync function chooseCity',
    '  )\n  fitRegionCities(region, regionCities)\n  setViewBack(showTaiwan)\n}\n\nasync function chooseCity',
)
replace_once('web/map/main.ts', '  map.setView(city.center, 11)\n', '')
replace_once(
    'web/map/main.ts',
    "  drawer.replaceChildren(drawerBack('返回區域', () => showRegion(city.region)), heading(city.name, '正在載入路線…'))\n  setViewBack(() => showRegion(city.region))",
    "  drawer.replaceChildren(drawerBack('返回區域', () => showRegion(city.region)), heading(city.name, '正在載入路線…'))\n  setDrawerAwareView(city.center, 11)\n  setViewBack(() => showRegion(city.region))",
)
replace_once(
    'web/map/main.ts',
    "    category = '全部'\n    renderRoutePicker()\n    setStatus(`${city.name} · ${routes.length} 條路線`)",
    "    category = '全部'\n    renderRoutePicker()\n    setDrawerAwareView(city.center, 11)\n    setStatus(`${city.name} · ${routes.length} 條路線`)",
)
replace_once(
    'web/map/main.ts',
    "      retryButton(() => void chooseCity(city)),\n    )\n  }\n}\n\nfunction renderRoutePicker",
    "      retryButton(() => void chooseCity(city)),\n    )\n    setDrawerAwareView(city.center, 11)\n  }\n}\n\nfunction renderRoutePicker",
)
replace_once(
    'web/map/main.ts',
    'function readCameraRect(element: HTMLElement): CameraRect {',
    '''function setDrawerAwareView(center: L.LatLngExpression, zoom: number) {
  map.setView(center, zoom, { animate: false })
  const offset = cameraPanOffset(drawerAwareCameraPadding())
  if (offset[0] || offset[1]) map.panBy(offset, { animate: false })
}

function fitRegionCities(region: (typeof regions)[number], regionCities: MapCity[]) {
  const bounds = L.latLngBounds([])
  regionCities.forEach((city) => bounds.extend(city.center))
  if (!bounds.isValid()) {
    setDrawerAwareView(region.center, region.zoom)
    return
  }
  map.fitBounds(bounds, {
    ...drawerAwareCameraPadding(),
    maxZoom: region.zoom,
    animate: false,
  })
}

function readCameraRect(element: HTMLElement): CameraRect {''',
)
