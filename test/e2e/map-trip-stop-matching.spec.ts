import { expect, test } from '@playwright/test'

const city = {
  code: 'Taipei',
  name: '臺北',
  region: 'north',
  center: [25, 121] as [number, number],
}

const fromCandidates = [
  { placeId: 'Taipei:from-a', name: '起點 A', latitude: 25, longitude: 121, distanceMeters: 86 },
  { placeId: 'Taipei:from-b', name: '起點 B', latitude: 25.001, longitude: 121.001, distanceMeters: 300 },
  { placeId: 'Taipei:from-c', name: '起點 C', latitude: 25.002, longitude: 121.002, distanceMeters: 140 },
]

const toCandidates = [
  { placeId: 'Taipei:to-a', name: '終點 A', latitude: 25.01, longitude: 121.02, distanceMeters: 42 },
  { placeId: 'Taipei:to-b', name: '終點 B', latitude: 25.011, longitude: 121.021, distanceMeters: 320 },
  { placeId: 'Taipei:to-c', name: '終點 C', latitude: 25.012, longitude: 121.022, distanceMeters: 155 },
]

const explicitPlace = {
  placeId: 'Taipei:explicit',
  name: '明確站',
  latitude: 25.03,
  longitude: 121.04,
}

function routeVariant() {
  return {
    variantKey: 'A:0',
    routeName: 'A',
    routeUid: 'A-uid',
    direction: 0,
    label: 'A 起點 → 終點',
    subRouteName: 'A',
    shape: {
      type: 'Feature' as const,
      properties: { routeUid: 'A-uid', direction: 0 },
      geometry: { type: 'LineString' as const, coordinates: [[121, 25], [121.01, 25.005], [121.02, 25.01]] },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [1, 2, 3].map((sequence) => ({
        type: 'Feature' as const,
        properties: { stopUid: `A-${sequence}`, stopName: `站牌 ${sequence}`, sequence },
        geometry: { type: 'Point' as const, coordinates: [121 + sequence * .01, 25 + sequence * .005] as [number, number] },
      })),
    },
    updatedAt: null,
  }
}

test('map-picked trip stops show nearby candidates and can be reversed', async ({ page }) => {
  const pageErrors: string[] = []
  let nearbyCalls = 0
  let directCalls = 0
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.route('**/api/v1/map/cities', async (route) => {
    await route.fulfill({ json: { cities: [city] } })
  })
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { routes: [{ routeName: 'Mock', category: '其他' }] } })
  })
  await page.route('**/api/v1/map/search*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    await route.fulfill({ json: { places: query === '明確站' ? [explicitPlace] : [] } })
  })
  await page.route('**/api/v1/map/nearby*', async (route) => {
    nearbyCalls += 1
    await route.fulfill({ json: { places: nearbyCalls % 2 === 1 ? fromCandidates : toCandidates } })
  })
  await page.route('**/api/v1/map/direct*', async (route) => {
    directCalls += 1
    await route.fulfill({ json: {
      routes: [{ routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點', subRouteName: 'A', boardSequence: 1, alightSequence: 3, stopCount: 2 }],
    } })
  })
  await page.route('**/api/v1/map/journey-eta', async (route) => {
    await route.fulfill({ json: { estimates: [{ key: 'direct:0', minutes: 6 }] } })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { variants: [routeVariant()] } })
  })

  await page.goto('/map?city=Taipei')
  await page.getByRole('button', { name: '路線規劃：選擇出發位置與目的地' }).click()
  const map = page.locator('#map')
  await expect(map).toHaveCount(1)
  await map.click({ position: { x: 120, y: 120 } })

  await expect(page.getByText('已配對：起點 A · 距離點選位置 86 m', { exact: true })).toBeVisible()
  const changeButtons = page.getByRole('button', { name: '改選附近站牌', exact: true })
  await expect(changeButtons).toHaveCount(1)
  await changeButtons.click()
  const candidates = page.locator('.trip-nearby-candidate')
  await expect(candidates).toHaveCount(3)
  await expect(candidates.nth(0)).toHaveAttribute('aria-pressed', 'true')
  await expect(candidates.nth(1)).toContainText('起點 B')
  await expect(candidates.nth(1)).toContainText('300 m')
  await candidates.nth(1).click()
  await expect(page.getByText('已配對：起點 B · 距離點選位置 300 m', { exact: true })).toBeVisible()
  await expect(page.getByText('站牌離點選位置稍遠', { exact: true })).toBeVisible()

  await map.click({ position: { x: 260, y: 180 } })
  await expect(page.getByText('已配對：終點 A · 距離點選位置 42 m', { exact: true })).toBeVisible()
  await expect.poll(() => directCalls).toBe(1)
  await expect(page.getByRole('heading', { name: '起點 B → 終點 A', exact: true })).toBeVisible()
  const matchedControls = page.locator('.trip-matched-summary')
  await expect(matchedControls).toHaveCount(2)

  await matchedControls.nth(1).getByRole('button', { name: '改選附近站牌', exact: true }).click()
  await expect(page.getByRole('button', { name: /返回行程候選/ })).toHaveCount(1)
  await expect(page.locator('.trip-nearby-candidate')).toHaveCount(3)
  await page.getByRole('button', { name: /返回行程候選/ }).click()
  await expect(page.getByRole('heading', { name: '起點 B → 終點 A', exact: true })).toBeVisible()
  await expect(page.locator('.trip-matched-summary')).toHaveCount(2)

  await page.locator('.trip-matched-summary').nth(1).getByRole('button', { name: '改選附近站牌', exact: true }).click()
  await page.locator('.trip-nearby-candidate').nth(1).click()
  await expect.poll(() => directCalls).toBe(2)
  await expect(page.getByRole('heading', { name: '起點 B → 終點 B', exact: true })).toBeVisible()

  await page.getByRole('button', { name: '路線規劃：選擇出發位置與目的地' }).click()
  await expect(page.locator('.trip-matched-summary')).toHaveCount(0)
  await page.getByRole('textbox', { name: '搜尋出發站牌' }).fill('明確站')
  await page.getByRole('button', { name: '明確站 站牌', exact: true }).click()
  await expect(page.getByText('已選擇：明確站', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: '改選附近站牌', exact: true })).toHaveCount(0)
  expect(pageErrors).toEqual([])
})
