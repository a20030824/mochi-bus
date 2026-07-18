import { expect, test, type Page } from './fixtures'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'

const city = { code: 'Taipei', name: '臺北', region: 'north', center: [25, 121] }
const places = {
  from: { placeId: 'Taipei:from', name: '起點', latitude: 25, longitude: 121 },
  to: { placeId: 'Taipei:to', name: '終點', latitude: 25.01, longitude: 121.02 },
}

function routeVariant(routeName: string) {
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `${routeName}-uid`,
    direction: 0,
    label: `${routeName} 起點 → 終點`,
    subRouteName: routeName,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: { type: 'LineString' as const, coordinates: [[121, 25], [121.02, 25.01]] },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [1, 2, 3].map((sequence) => ({
        type: 'Feature' as const,
        properties: { stopUid: `${routeName}-${sequence}`, stopName: `站牌 ${sequence}`, sequence },
        geometry: { type: 'Point' as const, coordinates: [121 + sequence * .005, 25 + sequence * .002] as [number, number] },
      })),
    },
    updatedAt: null,
  }
}

async function mockJourneyShell(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: 'A', category: '其他' }, { routeName: 'B', category: '其他' }] },
  }))
  await page.route('**/api/v1/map/search*', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    const place = query === '起點' ? places.from : query === '終點' ? places.to : undefined
    return route.fulfill({ json: { places: place ? [place] : [] } })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? 'A'
    return route.fulfill({ json: { variants: [routeVariant(routeName)] } })
  })
}

async function planJourney(page: Page) {
  await page.goto('/map?city=Taipei')
  await page.getByRole('button', { name: /路線規劃/ }).click()
  await page.getByRole('textbox', { name: '搜尋出發站牌' }).fill('起點')
  await page.getByRole('button', { name: '起點 站牌', exact: true }).click()
  await page.getByRole('textbox', { name: '搜尋目的地站牌' }).fill('終點')
  await page.getByRole('button', { name: '終點 站牌', exact: true }).click()
}

test('shows a schedule frequency as a range instead of an exact arrival', async ({ page }) => {
  await mockJourneyShell(page)
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [{
    routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點',
    subRouteName: 'A', boardSequence: 1, alightSequence: 3, stopCount: 3,
  }] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({ json: { estimates: [{
    key: 'direct:0', minutes: 15, source: 'schedule', departureBased: true,
    headwayMinutes: [8, 15], nextDay: false,
  }] } }))

  await planJourney(page)

  const card = page.locator('.direct-route-card')
  await expect(card).toContainText('8–15 分一班')
  await expect(card).not.toContainText('約 15 分')
  await expect(card).not.toContainText('15 分到站')
})

test('keeps transfer certainty unknown when both waits only come from schedules', async ({ page }) => {
  await mockJourneyShell(page)
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [] } }))
  await page.route('**/api/v1/map/transfer*', (route) => route.fulfill({ json: { plans: [{
    transferPlaceId: 'Taipei:transfer',
    transferName: '轉乘站',
    transferWalkMeters: 120,
    totalStops: 7,
    first: { routeName: 'A', variantKey: 'A:0', label: 'A 到轉乘站', boardSequence: 1, alightSequence: 3, stopCount: 3 },
    second: { routeName: 'B', variantKey: 'B:0', label: 'B 到終點', boardSequence: 1, alightSequence: 4, stopCount: 4 },
  }] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({ json: { estimates: [
    { key: 'transfer:0:first', minutes: 5, source: 'schedule', departureBased: true, headwayMinutes: null, nextDay: false },
    { key: 'transfer:0:second', minutes: 20, source: 'schedule', departureBased: false, headwayMinutes: null, nextDay: false },
  ] } }))

  await planJourney(page)

  const card = page.locator('.transfer-plan')
  await expect(card.locator('.transfer-title')).toContainText(/^一次轉乘車程＋步行 \d+–\d+ 分$/)
  await expect(card.locator('.transfer-assumption')).toContainText('未含候車與路況')
  await expect(card.locator('.transfer-assumption')).not.toContainText('依即時到站')
  await expect(card).not.toHaveClass(/connection-tight/)
  await expect(card.locator('.transfer-leg-button').nth(0)).toContainText('約 5 分後發車')
  await expect(card.locator('.transfer-leg-button').nth(1)).toContainText('約 20 分')
})

test('does not treat minutes without a source as a precise or best ETA', async ({ page }) => {
  await mockJourneyShell(page)
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [
    { routeName: 'B', variantKey: 'B:0', direction: 0, label: 'B 起點 → 終點', subRouteName: 'B', boardSequence: 1, alightSequence: 3, stopCount: 3 },
    { routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點', subRouteName: 'A', boardSequence: 1, alightSequence: 5, stopCount: 5 },
  ] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({ json: { estimates: [
    { key: 'direct:0', minutes: 1 },
    { key: 'direct:1', minutes: 8, source: 'realtime' },
  ] } }))

  await planJourney(page)

  const cards = page.locator('.direct-route-card')
  await expect(cards.nth(0)).toContainText('A')
  await expect(cards.nth(0)).toContainText('8 分到站')
  await expect(cards.nth(1)).toContainText('B')
  await expect(cards.nth(1)).not.toContainText('1 分')
})

test('keeps schedule candidates visible while exposing a journey degradation warning', async ({ page }) => {
  await mockJourneyShell(page)
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [{
    routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點',
    subRouteName: 'A', boardSequence: 1, alightSequence: 3, stopCount: 3,
  }] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({ json: {
    estimates: [{ key: 'direct:0', minutes: 12, source: 'schedule' }],
    warning: 'tdx-rate-limit',
  } }))

  await planJourney(page)

  await expect(page.locator('.direct-route-card')).toContainText('約 12 分')
  await expect(page.locator('.degraded-notice')).toContainText('即時查詢暫時受限')
  await expect(page.locator('.degraded-notice').getByRole('button', { name: '再試一次' })).toBeEnabled()
})

test('offers credential recovery when journey ETA rejects the personal token', async ({ page }) => {
  await mockJourneyShell(page)
  await page.route('**/api/v1/map/direct*', (route) => route.fulfill({ json: { routes: [{
    routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點',
    subRouteName: 'A', boardSequence: 1, alightSequence: 3, stopCount: 3,
  }] } }))
  await page.route('**/api/v1/map/journey-eta', (route) => route.fulfill({
    status: 401,
    json: { code: TDX_ACCESS_TOKEN_REJECTED_CODE, error: 'TDX 授權已失效' },
  }))

  await planJourney(page)

  const recovery = page.locator('#map-drawer .credential-recovery')
  await expect(recovery).toContainText('TDX 授權已失效')
  await expect(recovery.getByRole('button', { name: '再試一次' })).toBeEnabled()
  await expect(recovery.getByRole('link', { name: '檢查 TDX 設定' })).toHaveAttribute('href', '/setup')
})
