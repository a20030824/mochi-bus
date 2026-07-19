import { expect, test, type Page } from '@playwright/test'

const city = {
  code: 'Taipei',
  name: '台北',
  region: 'north',
  center: [25, 121] as [number, number],
}

const appearanceKey = 'mochi.bus.appearance.v3'

async function mockMap(page: Page) {
  await page.route('**/api/v1/map/cities', async (route) => {
    await route.fulfill({ json: { cities: [city] } })
  })
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { routes: [] } })
  })
}

test.describe('map appearance preference', () => {
  test.use({ colorScheme: 'dark' })

  test('defaults the interface and basemap to light even when the OS is dark', async ({ page }) => {
    await mockMap(page)
    await page.goto('/map')

    const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim())
    expect(ink).toBe('#29251f')

    const drawerBackground = await page.locator('#map-drawer')
      .evaluate((drawer) => getComputedStyle(drawer).backgroundColor)
    expect(drawerBackground).toContain('244, 239, 228')

    const tileFilter = await page.locator('.leaflet-tile-pane')
      .evaluate((pane) => getComputedStyle(pane).filter)
    expect(tileFilter).not.toContain('invert(1)')
  })

  test('switches the interface, basemap, and cartography together', async ({ page }) => {
    await page.addInitScript((key) => {
      if (localStorage.getItem(key) === null) {
        localStorage.setItem(key, JSON.stringify({
          version: 3,
          general: 'dark',
          map: 'dark',
        }))
      }
    }, appearanceKey)
    await mockMap(page)
    await page.goto('/map')

    const ink = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim())
    expect(ink).toBe('#f3ebde')
    const darkTileFilter = await page.locator('.leaflet-tile-pane')
      .evaluate((pane) => getComputedStyle(pane).filter)
    expect(darkTileFilter).toContain('invert(1)')

    await page.evaluate((key) => {
      localStorage.setItem(key, JSON.stringify({
        version: 3,
        general: 'dark',
        map: 'light',
      }))
    }, appearanceKey)
    await page.reload()

    const reloadedInk = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ink').trim())
    expect(reloadedInk).toBe('#29251f')
    const lightTileFilter = await page.locator('.leaflet-tile-pane')
      .evaluate((pane) => getComputedStyle(pane).filter)
    expect(lightTileFilter).not.toContain('invert(1)')
  })
})
