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
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: 'A', category: '其他' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: { timetable: { mode: 'none', services: [] } },
  }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: {
    vehicles: [{
      plate: 'KKA-1234',
      latitude: 23.002,
      longitude: 120.22,
      speed: 0,
      azimuth: 90,
      gpsTime: new Date(Date.now() - 18_000).toISOString(),
    }],
  } }))
}

test('shows plate and data age instead of speed in the desktop vehicle tooltip', async ({ page }) => {
  await mockRoute(page)
  await page.goto('/map?city=Tainan&route=A&variant=A%3A0')

  const marker = page.locator('.vehicle-marker-wrap')
  await expect(marker).toHaveCount(1)
  await marker.hover()

  const tooltip = page.locator('.leaflet-tooltip')
  await expect(tooltip).toContainText('KKA-1234')
  await expect(tooltip).toContainText(/\d+ 秒前更新/)
  await expect(tooltip).not.toContainText('km/h')
})
