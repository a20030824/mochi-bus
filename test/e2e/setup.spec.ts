import { expect, test } from './fixtures'

test.describe('/setup page', () => {
  test('renders saved boards as one divided list and keeps the active state separate from actions', async ({ page }) => {
    const boards = [
      {
        version: 2,
        id: 'active-board',
        title: '捷運景安站',
        city: 'NewTaipei',
        buses: [{ city: 'NewTaipei', routeName: '307', routeUid: 'NWT307', patternId: 'NWT307-0', stopName: '捷運景安站', stopUid: 'NWT1', direction: 0 }],
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
      {
        version: 2,
        id: 'second-board',
        title: '秀朗橋北',
        city: 'NewTaipei',
        buses: [{ city: 'NewTaipei', routeName: '918', routeUid: 'NWT918', patternId: 'NWT918-0', stopName: '秀朗橋北', stopUid: 'NWT2', direction: 0 }],
        createdAt: '2026-07-17T00:00:00.000Z',
        updatedAt: '2026-07-17T00:00:00.000Z',
      },
    ]
    await page.addInitScript((savedBoards) => {
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify(savedBoards))
      localStorage.setItem('mochi.bus.activeBoard.v2', savedBoards[0].id)
    }, boards)

    await page.goto('/setup')

    const rows = page.locator('.board-list > .board-item')
    await expect(rows).toHaveCount(2)
    await expect(rows.nth(0).locator('.board-status')).toHaveText('封面')
    await expect(rows.nth(0).getByRole('button', { name: '顯示在封面' })).toHaveCount(0)
    await expect(rows.nth(1).getByRole('button', { name: '顯示在封面' })).toBeVisible()
    await expect(rows.nth(0)).toHaveCSS('border-radius', '0px')

    await rows.nth(1).getByRole('button', { name: '顯示在封面' }).click()
    await expect(page.locator('.board-item[data-active="true"]')).toContainText('秀朗橋北')
    await expect(page.locator('.board-status')).toHaveCount(1)
  })

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
