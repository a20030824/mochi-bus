import { expect, test } from '@playwright/test'

// 深色模式煙霧測試:token 換色、紙面半透明改深紙、底圖反轉。
// 完整互動與視覺回歸仍以亮色為準;這裡只鎖住深色殼不會靜默失效。
test.use({ colorScheme: 'dark' })

const city = {
  code: 'Taipei',
  name: '台北',
  region: 'north',
  center: [25, 121] as [number, number],
}

test('map surfaces switch to dark paper without losing the cartography shell', async ({ page }) => {
  await page.route('**/api/v1/map/cities', async (route) => {
    await route.fulfill({ json: { cities: [city] } })
  })
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { routes: [] } })
  })

  await page.goto('/map')

  const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim())
  expect(ink).toBe('#f3ebde')

  const drawerBackground = await page.locator('#map-drawer')
    .evaluate((drawer) => getComputedStyle(drawer).backgroundColor)
  expect(drawerBackground).toContain('40, 37, 31')

  const tileFilter = await page.locator('.leaflet-tile-pane')
    .evaluate((pane) => getComputedStyle(pane).filter)
  expect(tileFilter).toContain('invert(1)')

  const brandColor = await page.locator('.map-brand')
    .evaluate((brand) => getComputedStyle(brand).color)
  expect(brandColor).toBe('rgb(243, 235, 222)')
})
