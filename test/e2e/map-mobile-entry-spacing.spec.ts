import { expect, test } from '@playwright/test'

const mobileViewports = [
  { label: '390 × 844', width: 390, height: 844 },
  { label: '360 × 800', width: 360, height: 800 },
]

for (const viewport of mobileViewports) {
  test(`keeps the locate action clear of the drawer edge at ${viewport.label}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
    await page.route('**/api/v1/map/cities', (route) => route.fulfill({
      json: {
        cities: [
          { code: 'Taipei', name: '臺北', region: 'north', center: [25.04, 121.56] },
          { code: 'Taichung', name: '臺中', region: 'central', center: [24.15, 120.68] },
          { code: 'Kaohsiung', name: '高雄', region: 'south', center: [22.63, 120.30] },
        ],
      },
    }))

    await page.goto('/map')
    const drawer = page.locator('#map-drawer')
    const locate = drawer.getByRole('button', { name: '跳到你所在的縣市' })
    await expect(locate).toBeVisible()

    const geometry = await drawer.evaluate((element) => {
      const button = element.querySelector<HTMLElement>('.locate-button')!
      const drawerRect = element.getBoundingClientRect()
      const buttonRect = button.getBoundingClientRect()
      return {
        bottomGap: drawerRect.bottom - buttonRect.bottom,
        drawerBottom: drawerRect.bottom,
        viewportHeight: window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })

    expect(geometry.bottomGap).toBeGreaterThanOrEqual(24)
    expect(geometry.drawerBottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.horizontalOverflow).toBe(false)
  })
}
