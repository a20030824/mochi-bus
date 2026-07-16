import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

const arrivals = [
  {
    routeName: '中山幹線(綠線)',
    routeUid: 'ARR-1',
    variantKey: 'ARR-1:0',
    direction: 0,
    label: '大富路 → 嘉義大學校區內',
    subRouteUid: 'ARR-1',
    subRouteName: '中山幹線(綠線)',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 120,
    etaLabel: '2 分',
    stopStatus: 0,
    source: 'realtime',
  },
  {
    routeName: '樂活1路',
    routeUid: 'ARR-2',
    variantKey: 'ARR-2:0',
    direction: 1,
    label: '嘉義大學校區內 → 大富路',
    subRouteUid: 'ARR-2',
    subRouteName: '樂活1路',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 540,
    etaLabel: '9 分',
    stopStatus: 0,
    source: 'stale-realtime',
  },
  {
    routeName: '7211',
    routeUid: 'ARR-3',
    variantKey: 'ARR-3:0',
    direction: 0,
    label: '嘉義公園 → 朴子轉運站',
    subRouteUid: 'ARR-3',
    subRouteName: '7211',
    stopUid: 'P1-S',
    stopName: '臺南火車站',
    stopSequence: 1,
    estimateSeconds: 4_800,
    etaLabel: '09:20 到站',
    stopStatus: 0,
    source: 'schedule',
  },
] as const

async function mockMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: [
        { routeName: '中山幹線(綠線)', category: '幹線' },
        { routeName: '樂活1路', category: '數字' },
        { routeName: '幸福小黃（預約）', category: '幸福／社區' },
        { routeName: '7211', category: '公路客運' },
        { routeName: '橘12', category: '接駁' },
        { routeName: '觀光公車', category: '觀光' },
      ],
    },
  }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({
    json: { place: { placeId: 'P1', name: '臺南火車站', latitude: 22.997, longitude: 120.212, distanceMeters: 76 } },
  }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({
    json: { routes: arrivals },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({
    json: { variants: [] },
  }))
}

test('keeps the route catalogue visual hierarchy', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await expect(drawer).toHaveScreenshot('map-route-catalogue.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('keeps ETA numbers dominant without hiding freshness', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南火車站' })).toBeVisible()
  await expect(drawer.getByText('稍早', { exact: true })).toBeVisible()
  await expect(drawer).toHaveScreenshot('map-place-arrivals.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('keeps the setup empty state focused on its primary action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/setup')

  const panel = page.locator('.setup-page .panel')
  await expect(panel.getByRole('heading', { name: '常用站牌' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '新增常用站牌' })).toBeVisible()
  await expect(panel).toHaveScreenshot('setup-empty-state.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})
