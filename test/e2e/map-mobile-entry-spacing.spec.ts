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

  await expect.poll(() => drawer.evaluate((element) => element.classList.contains('scrollable-below'))).toBe(false)
  const geometry = await drawer.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }))
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight + 1)
})

test('keeps the selected origin aligned with the destination search', async ({ page }) => {
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
  // 先完成選點，再縮到回報畫面的尺寸，避免把入口重疊問題混入這個狀態測試。
  await page.setViewportSize({ width: 420, height: 312 })

  await expect(drawer.getByRole('heading', { name: '選擇目的地' })).toBeVisible()
  await expect(drawer.locator('.drawer-heading p')).toHaveText('起點已選好。點地圖，或搜尋目的地站牌。')
  const summary = drawer.getByRole('button', { name: '更換出發站牌：公園南路' })
  await expect(summary).toContainText('更換')

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
