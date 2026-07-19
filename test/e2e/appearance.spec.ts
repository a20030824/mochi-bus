import { expect, test } from './fixtures'

test.describe('appearance settings', () => {
  test('shows segmented light and dark choices under Advanced > Appearance and persists changes', async ({ page }) => {
    await page.goto('/setup')
    await page.locator('.advanced-panel > summary').click()
    await page.locator('.appearance-panel > summary').click()

    const home = page.getByRole('radiogroup', { name: '首頁外觀' })
    const mapUi = page.getByRole('radiogroup', { name: '地圖介面' })
    const mapTiles = page.getByRole('radiogroup', { name: '地圖底圖' })

    await expect(page.getByRole('switch')).toHaveCount(0)
    await expect(home.getByRole('radio', { name: '深色' })).toBeChecked()
    await expect(home.getByRole('radio', { name: '淺色' })).not.toBeChecked()
    await expect(mapUi.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(mapUi.getByRole('radio', { name: '深色' })).not.toBeChecked()
    await expect(mapTiles.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(mapTiles.getByRole('radio', { name: '深色' })).not.toBeChecked()

    await mapUi.getByRole('radio', { name: '深色' }).check()
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('mochi.bus.appearance.v1') ?? 'null',
    ))).toMatchObject({ version: 1, home: 'dark', mapUI: 'dark', mapTiles: 'light' })

    await page.reload()
    await page.locator('.advanced-panel > summary').click()
    await page.locator('.appearance-panel > summary').click()
    await expect(
      page.getByRole('radiogroup', { name: '地圖介面' }).getByRole('radio', { name: '深色' }),
    ).toBeChecked()
  })

  test('uses the dark homepage default independently of the operating-system theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')

    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(33, 31, 27)')
    await expect(page.locator('html')).toHaveAttribute('data-home-theme', 'dark')
  })
})
