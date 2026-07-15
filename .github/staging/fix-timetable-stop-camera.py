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
    """function setDrawerAwareView(center: L.LatLngExpression, zoom: number) {\n  map.setView(center, zoom, { animate: false })\n  const offset = cameraPanOffset(drawerAwareCameraPadding())\n  if (offset[0] || offset[1]) map.panBy(offset, { animate: false })\n}\n""",
    """function setDrawerAwareView(center: L.LatLngExpression, zoom: number) {\n  const target = L.latLng(center)\n  const offset = cameraPanOffset(drawerAwareCameraPadding())\n  const projectedCenter = map.project(target, zoom).add(L.point(offset[0], offset[1]))\n  map.setView(map.unproject(projectedCenter, zoom), zoom, { animate: false })\n}\n""",
)

replace_once(
    "web/map/main.ts",
    """function renderRouteTimetable(variant: RouteMapVariant, timetable: RouteTimetable) {\n""",
    """function focusTimetableStop(variant: RouteMapVariant, stop: Omit<TimetableStop, 'hasTimes'>) {\n  selectionLayer.clearLayers()\n  const feature = variant.stops.features.find((candidate) => candidate.properties.stopUid === stop.stopUid)\n  if (!feature) return\n  const [longitude, latitude] = feature.geometry.coordinates\n  setDrawerAwareView([latitude, longitude], Math.max(map.getZoom(), 15))\n  const point = map.latLngToContainerPoint([latitude, longitude])\n  const center = map.getCenter()\n  mapNode.dataset.timetableCamera = `${stop.stopUid}|${center.lat}|${center.lng}|${map.getZoom()}|${point.x}|${point.y}`\n  const marker = unifiedStopMarker([latitude, longitude], true, '#b85f49').addTo(selectionLayer)\n  marker.getElement()?.classList.add('timetable-stop-focus')\n  marker.getElement()?.setAttribute('data-stop-uid', stop.stopUid)\n}\n\nfunction renderRouteTimetable(variant: RouteMapVariant, timetable: RouteTimetable) {\n""",
)

replace_once(
    "web/map/main.ts",
    """  const context = timetable.mode === 'stop'\n    ? timetable.selectedStop?.stopName\n    : timetable.mode === 'departure' ? `${timetable.departureStop?.stopName ?? '起點'}發車` : '班距'\n  setStatus(`${variant.routeName} · ${context ?? '時刻'}`)\n  setViewBack(back)\n}\n""",
    """  const context = timetable.mode === 'stop'\n    ? timetable.selectedStop?.stopName\n    : timetable.mode === 'departure' ? `${timetable.departureStop?.stopName ?? '起點'}發車` : '班距'\n  if (timetable.mode === 'stop' && timetable.selectedStop) {\n    queueMicrotask(() => focusTimetableStop(variant, timetable.selectedStop!))\n  } else {\n    selectionLayer.clearLayers()\n  }\n  setStatus(`${variant.routeName} · ${context ?? '時刻'}`)\n  setViewBack(back)\n}\n""",
)

replace_once(
    "test/e2e/map-timetable.spec.ts",
    """import { expect, test, type Page } from '@playwright/test'\n""",
    """import { expect, test, type Page } from '@playwright/test'\nimport { calculateCameraPadding } from '../../src/domain/map/camera-padding'\n""",
)

replace_once(
    "test/e2e/map-timetable.spec.ts",
    """  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')\n  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')\n  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()\n""",
    """  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')\n  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')\n  await expect.poll(async () => {\n    const geometry = await page.evaluate(() => {\n      const map = document.getElementById('map')!.getBoundingClientRect()\n      const drawer = document.getElementById('map-drawer')!.getBoundingClientRect()\n      const marker = document.querySelector<SVGElement>('.timetable-stop-focus[data-stop-uid="C2"]')?.getBoundingClientRect()\n      return {\n        map: { left: map.left, top: map.top, right: map.right, bottom: map.bottom, width: map.width, height: map.height },\n        drawer: { left: drawer.left, top: drawer.top, right: drawer.right, bottom: drawer.bottom, width: drawer.width, height: drawer.height },\n        marker: marker ? { left: marker.left, top: marker.top, right: marker.right, bottom: marker.bottom } : null,\n        camera: document.getElementById('map')?.dataset.timetableCamera ?? '',\n      }\n    })\n    if (!geometry.marker) return `missing C2 marker camera=${geometry.camera}`\n    const padding = calculateCameraPadding(geometry.map, geometry.drawer)\n    const expectedX = (geometry.map.left + padding.paddingTopLeft[0] + geometry.map.right - padding.paddingBottomRight[0]) / 2\n    const expectedY = (geometry.map.top + padding.paddingTopLeft[1] + geometry.map.bottom - padding.paddingBottomRight[1]) / 2\n    const markerX = (geometry.marker.left + geometry.marker.right) / 2\n    const markerY = (geometry.marker.top + geometry.marker.bottom) / 2\n    const aligned = Math.abs(markerX - expectedX) <= 10 && Math.abs(markerY - expectedY) <= 10\n    return aligned ? 'aligned' : `marker=${Math.round(markerX)},${Math.round(markerY)} expected=${Math.round(expectedX)},${Math.round(expectedY)} camera=${geometry.camera}`\n  }).toBe('aligned')\n  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()\n""",
)
