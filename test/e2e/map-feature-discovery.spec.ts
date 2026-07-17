import { expect, test } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

test('keeps feature labels open until each feature is actually used', async ({ page }) => {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '0右', category: '數字' }] },
  }))
  await page.route('**/api/v1/map/network*', (route) => route.fulfill({
    json: { version: 'test', routes: [], places: [] },
  }))

  await page.goto('/map?city=Tainan')

  const network = page.getByRole('button', { name: '切換全路網與全部站點' })
  const trip = page.getByRole('button', { name: '路線規劃：選擇出發位置與目的地' })
  await expect(network).toHaveClass(/feature-unseen/)
  await expect(network.locator('.map-feature-label')).toBeVisible()
  await expect(trip).toHaveClass(/feature-unseen/)
  await expect(trip.locator('.map-feature-label')).toBeVisible()

  await network.click()
  await expect(network).not.toHaveClass(/feature-unseen/)
  await expect(network.locator('.map-feature-label')).toBeHidden()
  await expect(trip).toHaveClass(/feature-unseen/)

  await page.reload()
  await expect(network).not.toHaveClass(/feature-unseen/)
  await expect(trip).toHaveClass(/feature-unseen/)

  await trip.click()
  await expect(page.locator('#map-status')).toHaveClass(/dismissed/)
  await page.getByRole('button', { name: '取消路線規劃' }).click()
  await expect(trip).not.toHaveClass(/feature-unseen/)
  await expect(trip.locator('.map-feature-label')).toBeHidden()

  await page.reload()
  await expect(network).not.toHaveClass(/feature-unseen/)
  await expect(trip).not.toHaveClass(/feature-unseen/)
  await expect.poll(async () => (await trip.boundingBox())?.width ?? 0).toBeLessThanOrEqual(41)
})
