import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

async function mockMap(page: Page, routeCount = 181) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: {
      routes: Array.from({ length: routeCount }, (_, index) => ({
        routeName: String(index + 1),
        category: index % 3 === 0 ? '幹線' : '數字',
      })),
    },
  }))
}

async function chromeGeometry(page: Page) {
  return page.evaluate(() => {
    const readVisibleRect = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (!element || getComputedStyle(element).display === 'none') return null
      const rect = element.getBoundingClientRect()
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
    }
    const drawer = readVisibleRect('#map-drawer')!
    const chrome = [
      readVisibleRect('.map-header'),
      readVisibleRect('#map-status'),
      readVisibleRect('.network-toggle'),
    ].filter((rect): rect is NonNullable<typeof rect> => rect !== null)
    const overlaps = chrome.map((rect) =>
      Math.min(rect.right, drawer.right) > Math.max(rect.left, drawer.left)
      && Math.min(rect.bottom, drawer.bottom) > Math.max(rect.top, drawer.top))
    return {
      drawer,
      chrome,
      overlaps,
      viewportHeight: window.innerHeight,
      topGap: drawer.top - Math.max(...chrome.map((rect) => rect.bottom)),
    }
  })
}

test('reserves space between the top chrome and a short landscape route catalogue', async ({ page }) => {
  await page.setViewportSize({ width: 636, height: 381 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator('.map-route-button')).toHaveCount(181)
  const geometry = await chromeGeometry(page)
  const drawerLayout = await drawer.evaluate((element) => {
    const drawerRect = element.getBoundingClientRect()
    const selectors = ['.drawer-back', '.drawer-heading', '.map-search', '.map-categories', '.drawer-scroll-shell']
    return selectors.map((selector) => {
      const rect = element.querySelector<HTMLElement>(selector)!.getBoundingClientRect()
      return {
        selector,
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        inside: rect.top >= drawerRect.top && rect.bottom <= drawerRect.bottom,
      }
    })
  })

  expect(geometry.overlaps).not.toContain(true)
  expect(geometry.topGap).toBeGreaterThanOrEqual(7)
  expect(geometry.drawer.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
  expect(drawerLayout.every((item) => item.inside), JSON.stringify(drawerLayout)).toBe(true)
  expect(drawerLayout.find((item) => item.selector === '.drawer-scroll-shell')!.height).toBeGreaterThanOrEqual(44)
})

test('keeps compact trip controls below the top chrome on an extremely short viewport', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 700 })
  await mockMap(page, 1)
  await page.goto('/map?city=Tainan')
  await page.locator('.trip-mode-button').click()
  await page.setViewportSize({ width: 420, height: 312 })

  const drawer = page.locator('#map-drawer')
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect(drawer.getByRole('textbox', { name: '搜尋出發站牌' })).toBeVisible()
  const geometry = await chromeGeometry(page)

  expect(geometry.overlaps).not.toContain(true)
  expect(geometry.topGap).toBeGreaterThanOrEqual(7)
  expect(geometry.drawer.bottom).toBeLessThanOrEqual(geometry.viewportHeight)
})
