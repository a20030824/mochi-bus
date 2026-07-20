import { expect, mockMapBootstrapCities, test } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

test('recovers map bootstrap in place after the network becomes available', async ({ page }) => {
  await page.setViewportSize({ width: 636, height: 381 })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  // SSR 內嵌清單一律缺席,逼前端第一次一定要走網路回退,才測得到離線恢復。
  await mockMapBootstrapCities(page, null)
  let cityRequests = 0
  await page.route('**/api/v1/map/cities', (route) => {
    cityRequests += 1
    if (cityRequests === 1) return route.fulfill({ status: 503, json: { error: 'offline' } })
    return route.fulfill({ json: { cities: [city] } })
  })

  await page.goto('/map')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '地圖初始化失敗' })).toBeVisible()
  const retry = drawer.getByRole('button', { name: '再試一次' })
  await expect(retry).toBeVisible()
  await expect(retry).toBeEnabled()

  await retry.click()

  await expect(drawer.getByRole('heading', { name: '先從哪裡開始？' })).toBeVisible()
  await expect.poll(() => cityRequests).toBe(2)
  await expect(page).toHaveURL('/map')
})
