import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const variant = {
  variantKey: 'A:0',
  routeName: 'A',
  routeUid: 'TNN-A',
  direction: 0,
  label: '臺南火車站 → 永康火車站',
  subRouteName: 'A',
  updatedAt: null,
  shape: {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[120.212, 22.997], [120.23, 23.01]] },
  },
  stops: { type: 'FeatureCollection', features: [] },
}

async function mockRoute(page: Page) {
  let vehicleRequests = 0
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: 'A', category: '其他' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: { timetable: { mode: 'none', services: [] } },
  }))
  await page.route('**/api/v1/map/vehicles*', (route) => {
    vehicleRequests += 1
    return route.fulfill({ json: {
      vehicles: [{
        plate: 'KKA-1234',
        latitude: vehicleRequests === 1 ? 23.002 : 23.003,
        longitude: vehicleRequests === 1 ? 120.22 : 120.221,
        speed: 0,
        azimuth: 90,
        gpsTime: new Date(Date.now() - (vehicleRequests === 1 ? 18_000 : 5_000)).toISOString(),
      }],
      ...(vehicleRequests === 1 ? { warning: 'tdx-rate-limit' } : {}),
    } })
  })
  return () => vehicleRequests
}

test('opens vehicle update info on tap and restores it after an immediate refresh', async ({ page }) => {
  const vehicleRequestCount = await mockRoute(page)
  await page.goto('/map?city=Tainan&route=A&variant=A%3A0')

  const marker = page.locator('.vehicle-marker-wrap')
  await expect(marker).toHaveCount(1)
  // Locator actions wait for the animated Leaflet marker to be stable and
  // recompute its hit point immediately before dispatching the touch event.
  await marker.tap()

  const popup = page.locator('.vehicle-popup')
  await expect(popup).toContainText('KKA-1234')
  await expect(popup).toContainText(/\d+ 秒前更新/)
  await expect(popup).not.toContainText('km/h')
  await expect(page.locator('.leaflet-tooltip')).toHaveCount(0)

  await page.locator('.vehicle-degraded-notice').getByRole('button', { name: '再試一次' }).tap()
  await expect.poll(vehicleRequestCount).toBe(2)
  await expect(popup).toContainText('KKA-1234 · 剛剛更新')
  await expect(page.locator('.leaflet-tooltip')).toHaveCount(0)
})
