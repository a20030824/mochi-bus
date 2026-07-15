from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    target = Path(path)
    text = target.read_text()
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"{path}: expected one match, found {count}")
    target.write_text(text.replace(old, new, 1))


replace_once(
    "web/map/main.ts",
    """function renderRouteTimetable(variant: RouteMapVariant, timetable: RouteTimetable) {\n""",
    """function focusTimetableStop(variant: RouteMapVariant, stop: Omit<TimetableStop, 'hasTimes'>) {\n  selectionLayer.clearLayers()\n  const feature = variant.stops.features.find((candidate) => candidate.properties.stopUid === stop.stopUid)\n  if (!feature) return\n  const [longitude, latitude] = feature.geometry.coordinates\n  unifiedStopMarker([latitude, longitude], true, '#b85f49').addTo(selectionLayer)\n  setDrawerAwareView([latitude, longitude], Math.max(map.getZoom(), 15))\n}\n\nfunction renderRouteTimetable(variant: RouteMapVariant, timetable: RouteTimetable) {\n""",
)

replace_once(
    "web/map/main.ts",
    """  const context = timetable.mode === 'stop'\n    ? timetable.selectedStop?.stopName\n    : timetable.mode === 'departure' ? `${timetable.departureStop?.stopName ?? '起點'}發車` : '班距'\n  setStatus(`${variant.routeName} · ${context ?? '時刻'}`)\n  setViewBack(back)\n}\n""",
    """  const context = timetable.mode === 'stop'\n    ? timetable.selectedStop?.stopName\n    : timetable.mode === 'departure' ? `${timetable.departureStop?.stopName ?? '起點'}發車` : '班距'\n  if (timetable.mode === 'stop' && timetable.selectedStop) focusTimetableStop(variant, timetable.selectedStop)\n  else selectionLayer.clearLayers()\n  setStatus(`${variant.routeName} · ${context ?? '時刻'}`)\n  setViewBack(back)\n}\n""",
)

replace_once(
    "test/e2e/map-timetable.spec.ts",
    """async function mockRoute(page: Page) {\n""",
    """async function latLngScreenPoint(page: Page, center: [number, number]) {\n  return page.evaluate(([latitude, longitude]) => {\n    const pattern = /\\/(\\d+)\\/(\\d+)\\/(\\d+)\\.png(?:$|\\?)/\n    const tile = Array.from(document.querySelectorAll<HTMLImageElement>('.leaflet-tile')).find((candidate) =>\n      pattern.test(candidate.currentSrc || candidate.src))\n    if (!tile) return null\n    const match = (tile.currentSrc || tile.src).match(pattern)\n    if (!match) return null\n\n    const zoom = Number(match[1])\n    const tileX = Number(match[2])\n    const tileY = Number(match[3])\n    const worldSize = 256 * 2 ** zoom\n    const sine = Math.sin(latitude * Math.PI / 180)\n    const worldX = (longitude + 180) / 360 * worldSize\n    const worldY = (0.5 - Math.log((1 + sine) / (1 - sine)) / (4 * Math.PI)) * worldSize\n    const tileRect = tile.getBoundingClientRect()\n    return {\n      x: tileRect.left + worldX - tileX * 256,\n      y: tileRect.top + worldY - tileY * 256,\n    }\n  }, center)\n}\n\nasync function mockRoute(page: Page) {\n""",
)

replace_once(
    "test/e2e/map-timetable.spec.ts",
    """  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')\n  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')\n  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()\n""",
    """  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')\n  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')\n  await expect.poll(async () => {\n    const [point, geometry] = await Promise.all([\n      latLngScreenPoint(page, [23.46, 120.44]),\n      page.evaluate(() => {\n        const map = document.getElementById('map')!.getBoundingClientRect()\n        const drawer = document.getElementById('map-drawer')!.getBoundingClientRect()\n        return { map: { left: map.left, top: map.top, right: map.right }, drawerTop: drawer.top }\n      }),\n    ])\n    if (!point) return false\n    const expectedX = (geometry.map.left + 45 + geometry.map.right - 45) / 2\n    const expectedY = (geometry.map.top + 90 + geometry.drawerTop - 48) / 2\n    return Math.abs(point.x - expectedX) <= 10 && Math.abs(point.y - expectedY) <= 10\n  }).toBe(true)\n  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()\n""",
)
