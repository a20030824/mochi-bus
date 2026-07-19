import { expect, test } from './fixtures'

test.describe('appearance settings', () => {
  test('shows the requested defaults under Advanced > Appearance and persists changes', async ({ page }) => {
    await page.goto('/setup')
    await page.locator('.advanced-panel > summary').click()
    await page.locator('.appearance-panel > summary').click()

    const home = page.getByRole('switch', { name: '首頁外觀' })
    const mapUi = page.getByRole('switch', { name: '地圖介面' })
    const mapTiles = page.getByRole('switch', { name: '地圖底圖' })

    await expect(home).toBeChecked()
    await expect(mapUi).not.toBeChecked()
    await expect(mapTiles).not.toBeChecked()
    await expect(page.locator('#appearance-home-value')).toHaveText('深色')
    await expect(page.locator('#appearance-map-ui-value')).toHaveText('淺色')
    await expect(page.locator('#appearance-map-tiles-value')).toHaveText('淺色')

    await mapUi.check()
    await expect(page.locator('#appearance-map-ui-value')).toHaveText('深色')
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('mochi.bus.appearance.v1') ?? 'null',
    ))).toMatchObject({ version: 1, home: 'dark', mapUi: 'dark', mapTiles: 'light' })

    await page.reload()
    await page.locator('.advanced-panel > summary').click()
    await page.locator('.appearance-panel > summary').click()
    await expect(page.getByRole('switch', { name: '地圖介面' })).toBeChecked()
  })

  test('uses the dark homepage default independently of the operating-system theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')

    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(33, 31, 27)')
    await expect(page.locator('html')).toHaveAttribute('data-home-theme', 'dark')
  })
})
