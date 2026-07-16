import { expect, test } from './fixtures'

test.describe('/setup page', () => {
  test('golden path: pick a route, pick a stop, see suggestions', async ({ page }) => {
    await page.goto('/setup')
    await expect(page.locator('#board-list')).toBeVisible()

    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')

    await page.locator('.route-choice').first().click()
    await page.waitForSelector('#direction-step .result-card')

    await page.locator('#direction-step .result-card').first().locator('button.primary').click()
    await page.waitForSelector('#suggestion-step .sticky-save')

    await expect(page.locator('#suggestion-step .check-row')).not.toHaveCount(0)
  })

  // 回歸測試:hidePicker/backToRoutes 曾經只清 selectedRoute、不搶新 epoch,
  // 使用者在 loadSuggestions 的 stop-routes fetch 還沒回來前就關掉 picker,
  // fetch 回來後會用「沒有更新」的舊檢查通過,卻讀到已經被清空的
  // selectedRoute,炸出 TypeError。見 web/setup/main.ts 的 hidePicker/backToRoutes。
  test('closing the picker mid-flight does not throw when the delayed fetch resolves', async ({ page }) => {
    await page.route('**/api/v1/stop-routes*', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      await route.continue()
    })

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.waitForSelector('.route-choice')
    await page.locator('.route-choice').first().click()
    await page.waitForSelector('#direction-step .result-card')
    await page.locator('#direction-step .result-card').first().locator('button.primary').click()
    await page.waitForSelector('#suggestion-step p')

    // 故意在延遲的 fetch 還沒回來時關閉 picker。
    await page.click('#close-picker')
    await page.waitForTimeout(2200)
  })

  test('Escape closes the picker and returns focus to the trigger button (A11Y-001)', async ({ page }) => {
    await page.goto('/setup')
    await page.click('#add-board-button')
    await expect(page.locator('#picker-panel')).toBeVisible()
    await expect(page.locator('#city')).toBeFocused()

    await page.keyboard.press('Escape')

    await expect(page.locator('#picker-panel')).toBeHidden()
    await expect(page.locator('#add-board-button')).toBeFocused()
  })
})
