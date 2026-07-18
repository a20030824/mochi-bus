import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.997, 120.212] }
const place = { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 0 }
const arrival = {
  routeUid: 'TNN-A',
  routeName: 'A',
  variantKey: 'A:0',
  direction: 0,
  label: '臺南火車站 → 永康火車站',
  subRouteName: 'A',
  stopUid: 'STOP-1',
  stopName: '臺南火車站',
  stopSequence: 1,
  estimateSeconds: 600,
  etaLabel: '約 10 分',
  stopStatus: 0,
  source: 'schedule',
}

async function mockMapShell(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: 'A', category: '其他' }] },
  }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({ json: { place } }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [] } }))
}

test('keeps schedule rows visible with retry and setup actions while realtime is rate limited', async ({ page }) => {
  await mockMapShell(page)
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: {
    routes: [arrival],
    warning: 'tdx-rate-limit',
    realtime: { candidates: 1, queries: 0, rateLimited: true },
  } }))

  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.locator('.place-route-row')).toContainText('約10分')
  const notice = drawer.locator('.degraded-notice')
  await expect(notice).toContainText('即時查詢暫時受限')
  await expect(notice.getByRole('button', { name: '再試一次' })).toBeVisible()
  await expect(notice.getByRole('link', { name: '檢查 TDX 設定' })).toHaveAttribute('href', '/setup')
})

test('offers credential recovery instead of a generic dead end after token refresh is rejected', async ({ page }) => {
  await mockMapShell(page)
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({
    status: 401,
    json: { code: TDX_ACCESS_TOKEN_REJECTED_CODE, error: 'TDX 授權已失效' },
  }))

  await page.goto('/map?city=Tainan&place=P1')

  const recovery = page.locator('#map-drawer .credential-recovery')
  await expect(recovery).toContainText('TDX 授權已失效')
  await expect(recovery.getByRole('button', { name: '再試一次' })).toBeVisible()
  await expect(recovery.getByRole('link', { name: '檢查 TDX 設定' })).toHaveAttribute('href', '/setup')
})

test('keeps the route usable and exposes vehicle degradation recovery', async ({ page }) => {
  await mockMapShell(page)
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [{
    variantKey: 'A:0', routeName: 'A', routeUid: 'TNN-A', direction: 0,
    label: '臺南火車站 → 永康火車站', subRouteName: 'A', updatedAt: null,
    shape: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[120.212, 22.997], [120.23, 23.01]] } },
    stops: { type: 'FeatureCollection', features: [] },
  }] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({ json: {
    timetable: { mode: 'none', services: [] },
  } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: {
    vehicles: [], warning: 'tdx-rate-limit',
  } }))

  await page.goto('/map?city=Tainan&route=A&variant=A%3A0')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: 'A' })).toBeVisible()
  const notice = drawer.locator('.vehicle-degraded-notice')
  await expect(notice).toContainText('即時查詢暫時受限')
  await expect(notice.getByRole('button', { name: '再試一次' })).toBeEnabled()
  await expect(notice.getByRole('link', { name: '檢查 TDX 設定' })).toHaveAttribute('href', '/setup')
})
