import { expect, test, type Page } from '@playwright/test'
import { calculateCameraPadding } from '../../src/domain/map/camera-padding'

const variant = {
  variantKey: 'CHI-7211:0', routeName: '7211', routeUid: 'CHI7211', subRouteUid: 'CHI-7211', direction: 0 as const,
  label: '嘉義公園 → 朴子轉運站', subRouteName: '7211', updatedAt: null,
  shape: { type: 'Feature' as const, properties: { routeUid: 'CHI7211', direction: 0 }, geometry: { type: 'LineString' as const, coordinates: [[120.45, 23.48], [120.44, 23.46], [120.24, 23.46]] } },
  stops: { type: 'FeatureCollection' as const, features: [
    { type: 'Feature' as const, properties: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }, geometry: { type: 'Point' as const, coordinates: [120.45, 23.48] as [number, number] } },
    { type: 'Feature' as const, properties: { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }, geometry: { type: 'Point' as const, coordinates: [120.44, 23.46] as [number, number] } },
    { type: 'Feature' as const, properties: { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3 }, geometry: { type: 'Point' as const, coordinates: [120.24, 23.46] as [number, number] } },
  ] },
}

function timetable(stopUid = 'C1') {
  const stop = stopUid === 'C2'
    ? { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }
    : { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }
  const offset = stopUid === 'C2' ? 12 : 0
  const time = (hour: number) => `${String(hour).padStart(2, '0')}:${String(offset).padStart(2, '0')}`
  return {
    schemaVersion: 1, city: 'ChiayiCounty', routeName: '7211', variantKey: variant.variantKey,
    routeUid: variant.routeUid, direction: 0, source: 'snapshot',
    timetable: {
      mode: 'stop', selectedStop: stop, departureStop: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }, timedStopCount: 3,
      stops: [
        { stopUid: 'C1', stopName: '嘉義公園', sequence: 1, hasTimes: true },
        { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2, hasTimes: true },
        { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3, hasTimes: true },
      ],
      services: [
        { id: '1-2-3-4-5', label: '平日', days: [1, 2, 3, 4, 5], today: true, times: [time(6), time(7), time(22)], periods: [], firstTime: time(6), lastTime: time(22) },
        { id: '6', label: '週六', days: [6], today: false, times: [time(7), time(19)], periods: [], firstTime: time(7), lastTime: time(19) },
      ],
    },
  }
}

async function mockRoute(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [{ code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.46, 120.35] }] } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => {
    const stopUid = new URL(route.request().url()).searchParams.get('stopUid') ?? 'C1'
    return route.fulfill({ json: timetable(stopUid) })
  })
}

test('opens a per-stop timetable without turning it into a wide table', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockRoute(page)
  await page.goto(`/map?city=ChiayiCounty&route=7211&variant=${encodeURIComponent(variant.variantKey)}`)

  const drawer = page.locator('#map-drawer')
  // 時刻摘要列本身就是時刻表入口:載入完成前是佔位、完成後才可點。
  await expect(drawer.locator('.route-service-summary')).toContainText('首班 06:00 · 末班 22:00')
  await drawer.getByRole('button', { name: '查看時刻表' }).click()

  await expect(drawer.getByRole('heading', { name: '7211' })).toBeVisible()
  await expect(drawer.locator('.drawer-heading p')).toContainText('時刻')
  const stopSelect = drawer.getByRole('combobox', { name: '站牌' })
  await expect(stopSelect).toBeVisible()
  await stopSelect.selectOption('C2')
  await expect(stopSelect).toHaveValue('C2')
  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')
  await expect(drawer.locator('.timetable-hour-row').first()).toContainText('12')
  await expect.poll(async () => {
    const geometry = await page.evaluate(() => {
      const map = document.getElementById('map')!.getBoundingClientRect()
      const drawer = document.getElementById('map-drawer')!.getBoundingClientRect()
      const marker = document.querySelector<SVGElement>('.timetable-stop-focus[data-stop-uid="C2"]')?.getBoundingClientRect()
      return {
        map: { left: map.left, top: map.top, right: map.right, bottom: map.bottom, width: map.width, height: map.height },
        drawer: { left: drawer.left, top: drawer.top, right: drawer.right, bottom: drawer.bottom, width: drawer.width, height: drawer.height },
        marker: marker ? { left: marker.left, top: marker.top, right: marker.right, bottom: marker.bottom } : null,
      }
    })
    if (!geometry.marker) return false
    const padding = calculateCameraPadding(geometry.map, geometry.drawer)
    const expectedX = (geometry.map.left + padding.paddingTopLeft[0] + geometry.map.right - padding.paddingBottomRight[0]) / 2
    const expectedY = (geometry.map.top + padding.paddingTopLeft[1] + geometry.map.bottom - padding.paddingBottomRight[1]) / 2
    const markerX = (geometry.marker.left + geometry.marker.right) / 2
    const markerY = (geometry.marker.top + geometry.marker.bottom) / 2
    return Math.abs(markerX - expectedX) <= 10 && Math.abs(markerY - expectedY) <= 10
  }).toBe(true)
  await expect(drawer.getByRole('tab', { name: '週六' })).toBeVisible()

  const geometry = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { right: rect.right, bottom: rect.bottom, viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth }
  })
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth)
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(geometry.overflow).toBe(false)
})
