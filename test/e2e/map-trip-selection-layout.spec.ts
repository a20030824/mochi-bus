import { expect, test } from './fixtures'

test('aligns the selected origin with destination search and keeps the compact icon', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 700 })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({
    json: { cities: [{ code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }] },
  }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '0右', category: '數字' }] },
  }))
  await page.route('**/api/v1/map/search*', (route) => route.fulfill({
    json: { places: [{ placeId: 'PARK', name: '公園南路', latitude: 23.001, longitude: 120.211 }] },
  }))

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '路線規劃：選擇出發位置與目的地' }).click()
  await drawer.getByRole('textbox', { name: '搜尋出發站牌' }).fill('公園南路')
  await drawer.getByRole('button', { name: /公園南路/ }).click()
  await page.setViewportSize({ width: 420, height: 312 })

  const summary = drawer.getByRole('button', { name: '更換出發站牌：公園南路' })
  await expect(summary).toContainText('↻')
  await expect(summary).not.toContainText('更換')
  const geometry = await drawer.evaluate((element) => {
    const summaryRect = element.querySelector<HTMLElement>('.trip-matched-summary')!.getBoundingClientRect()
    const searchRect = element.querySelector<HTMLElement>('.place-search .map-search')!.getBoundingClientRect()
    return {
      widthDifference: Math.abs(summaryRect.width - searchRect.width),
      verticalGap: searchRect.top - summaryRect.bottom,
    }
  })
  expect(geometry.widthDifference).toBeLessThanOrEqual(1)
  expect(geometry.verticalGap).toBeGreaterThanOrEqual(9)
})
