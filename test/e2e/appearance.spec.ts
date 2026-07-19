import type { Page } from '@playwright/test'
import { expect, test } from './fixtures'

const appearanceKey = 'mochi.bus.appearance.v3'

async function openAppearanceSettings(page: Page) {
  await page.goto('/setup')
  await page.locator('.advanced-panel > summary').click()
  await page.locator('.appearance-panel > summary').click()
}

test.describe('appearance settings', () => {
  test('shows two full-area choices, applies them immediately, and persists them', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await openAppearanceSettings(page)

    const general = page.getByRole('radiogroup', { name: '一般介面' })
    const map = page.getByRole('radiogroup', { name: '地圖外觀' })

    await expect(page.locator('#clear-local-button + p')).toContainText('外觀')
    await expect(page.getByRole('switch')).toHaveCount(0)
    await expect(page.locator('.appearance-row')).toHaveCount(2)
    await expect(page.locator('.appearance-message')).toHaveCount(0)
    await expect(general.getByRole('radio', { name: '深色' })).toBeChecked()
    await expect(map.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-appearance-page', 'general')
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'dark')

    // Click near the edge of each half rather than on its label text.
    await general.locator('.appearance-segment').first().click({ position: { x: 4, y: 4 } })
    await expect(general.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(general.locator('.appearance-segmented')).toHaveAttribute('data-selected', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'light')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
    await expect(page.locator('.panel').first()).toHaveCSS('border-top-color', 'rgb(222, 214, 201)')
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#f7f2e8')

    await map.locator('.appearance-segment').nth(1).click({ position: { x: 4, y: 4 } })
    await expect(map.getByRole('radio', { name: '深色' })).toBeChecked()
    await expect(map.locator('.appearance-segmented')).toHaveAttribute('data-selected', 'dark')
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), appearanceKey))
      .toEqual({ version: 3, general: 'light', map: 'dark' })

    await page.reload()
    await page.locator('.advanced-panel > summary').click()
    await page.locator('.appearance-panel > summary').click()
    await expect(page.getByRole('radiogroup', { name: '一般介面' }).getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(page.getByRole('radiogroup', { name: '地圖外觀' }).getByRole('radio', { name: '深色' })).toBeChecked()
  })

  test('clearing local data resets storage, controls, and the current setup page', async ({ page }) => {
    await openAppearanceSettings(page)

    const general = page.getByRole('radiogroup', { name: '一般介面' })
    const map = page.getByRole('radiogroup', { name: '地圖外觀' })
    await general.getByRole('radio', { name: '淺色' }).check()
    await map.getByRole('radio', { name: '深色' }).check()

    page.once('dialog', (dialog) => dialog.accept())
    await page.locator('#clear-local-button').click()

    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), appearanceKey)).toBeNull()
    await expect(general.getByRole('radio', { name: '深色' })).toBeChecked()
    await expect(map.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'dark')
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(33, 31, 27)')
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#211f1b')

    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'light')
    await expect(page.locator('html')).not.toHaveAttribute('data-map-ui-theme')
    await expect(page.locator('html')).not.toHaveAttribute('data-map-tiles-theme')
  })

  test('cancelling local-data clearing preserves the appearance preference', async ({ page }) => {
    await openAppearanceSettings(page)
    const general = page.getByRole('radiogroup', { name: '一般介面' })
    await general.getByRole('radio', { name: '淺色' }).check()

    page.once('dialog', (dialog) => dialog.dismiss())
    await page.locator('#clear-local-button').click()

    await expect(general.getByRole('radio', { name: '淺色' })).toBeChecked()
    await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? 'null'), appearanceKey))
      .toMatchObject({ general: 'light' })
  })

  test('applies the general preference to non-map and zero-script pages', async ({ page }) => {
    await page.goto('/setup')
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
      version: 3,
      general: 'light',
      map: 'dark',
    })), appearanceKey)

    for (const path of ['/', '/setup', '/route']) {
      await page.goto(path)
      await expect(page.locator('html')).toHaveAttribute('data-appearance-page', 'general')
      await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'light')
      await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(247, 242, 232)')
      await expect(page.locator('script[src="/assets/appearance.js"]')).toHaveCount(1)
    }
  })

  test('applies one map preference to the interface, basemap, and browser chrome', async ({ page }) => {
    await page.goto('/setup')
    await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({
      version: 3,
      general: 'light',
      map: 'dark',
    })), appearanceKey)

    await page.goto('/map')
    await expect(page.locator('html')).toHaveAttribute('data-appearance-page', 'map')
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'light')
    await expect(page.locator('html')).toHaveAttribute('data-map-theme', 'dark')
    await expect(page.locator('#map')).toHaveCSS('background-color', 'rgb(35, 33, 32)')
    await expect(page.locator('.leaflet-tile-pane')).toHaveCSS('filter', /invert\(1\)/)
    await expect(page.locator('meta[name="theme-color"]').first()).toHaveAttribute('content', '#1d1c19')
  })

  test('synchronizes an appearance change to another open tab', async ({ page, context }) => {
    await openAppearanceSettings(page)
    const other = await context.newPage()
    await other.goto('/setup')

    await page.getByRole('radiogroup', { name: '一般介面' }).getByRole('radio', { name: '淺色' }).check()
    await expect(other.locator('html')).toHaveAttribute('data-general-theme', 'light')
    await expect(other.locator('body')).toHaveCSS('background-color', 'rgb(247, 242, 232)')

    await other.close()
  })

  test('uses the dark general default independently of the operating-system theme', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')

    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(33, 31, 27)')
    await expect(page.locator('html')).toHaveAttribute('data-general-theme', 'dark')
  })
})
