import { expect, test } from './fixtures'

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
        paddingBottom: Number.parseFloat(getComputedStyle(element).paddingBottom),
        drawerBottom: drawerRect.bottom,
        viewportHeight: window.innerHeight,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      }
    })

    expect(Math.abs(geometry.bottomGap - geometry.paddingBottom)).toBeLessThanOrEqual(1)
    expect(geometry.drawerBottom).toBeLessThanOrEqual(geometry.viewportHeight)
    expect(geometry.horizontalOverflow).toBe(false)
  })
}

test('does not show a scrollbar when a short region drawer already fits', async ({ page }) => {
  await page.setViewportSize({ width: 636, height: 381 })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({
    json: {
      cities: [
        { code: 'YilanCounty', name: '宜蘭', region: 'east', center: [24.70, 121.74] },
        { code: 'HualienCounty', name: '花蓮', region: 'east', center: [23.99, 121.61] },
        { code: 'TaitungCounty', name: '臺東', region: 'east', center: [22.75, 121.15] },
      ],
    },
  }))

  await page.goto('/map')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '東部' }).click()
  await expect(drawer.getByRole('heading', { name: '東部' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'compact')

  await expect(drawer.locator(':scope > .drawer-scroll-shell')).toHaveCount(0)
  await expect(drawer.locator('.drawer-scroll-fade')).toHaveCount(0)
  const geometry = await drawer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
})
