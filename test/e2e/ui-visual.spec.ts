import { expect, test } from './fixtures'

test('softens marquee text at the fixed sign edges', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const sign = page.locator('#onboard-sign')
  await expect(sign).toBeVisible()
  const layers = await sign.evaluate((element) => {
    const signStyle = getComputedStyle(element)
    const textStyle = getComputedStyle(element.querySelector('.onboard-sign-text')!)
    const textureStyle = getComputedStyle(element, '::after')
    return {
      signBackground: signStyle.backgroundColor,
      signMask: signStyle.maskImage,
      textMask: textStyle.maskImage,
      textureBackground: textureStyle.backgroundImage,
    }
  })
  expect(layers.signBackground).toBe('rgb(33, 30, 25)')
  expect(layers.signMask).toBe('none')
  expect(layers.textMask).toContain('32px')
  expect(layers.textureBackground).toContain('repeating-linear-gradient')
  await expect(sign).toHaveScreenshot('home-marquee.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('keeps the setup empty state focused on its primary action', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/setup')

  const panel = page.locator('.setup-page > .panel:not([hidden])')
  await expect(panel.getByRole('heading', { name: '常用站牌' })).toBeVisible()
  await expect(panel.getByRole('button', { name: '新增常用站牌' })).toBeVisible()
  await expect(panel.locator('.advanced-panel > summary')).toHaveCSS('color', 'rgb(107, 99, 89)')
  await expect(panel.locator('.about-panel > summary')).toHaveCSS('color', 'rgb(107, 99, 89)')
  await expect(panel).toHaveScreenshot('setup-empty-state.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})

test('uses rules instead of nested cards for saved boards', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.addInitScript(() => {
    const shared = {
      version: 2,
      city: 'NewTaipei',
      createdAt: '2026-07-17T00:00:00.000Z',
      updatedAt: '2026-07-17T00:00:00.000Z',
    }
    const boards = [
      { ...shared, id: 'active-board', title: '捷運景安站', buses: [{ city: 'NewTaipei', routeName: '307', routeUid: 'NWT307', patternId: 'NWT307-0', stopName: '捷運景安站', stopUid: 'NWT1', direction: 0 }] },
      { ...shared, id: 'second-board', title: '秀朗橋北', buses: [{ city: 'NewTaipei', routeName: '918', routeUid: 'NWT918', patternId: 'NWT918-0', stopName: '秀朗橋北', stopUid: 'NWT2', direction: 0 }] },
    ]
    localStorage.setItem('mochi.bus.boards.v2', JSON.stringify(boards))
    localStorage.setItem('mochi.bus.activeBoard.v2', boards[0].id)
  })
  await page.goto('/setup')

  const panel = page.locator('.setup-page > .panel:not([hidden])')
  await expect(panel.locator('.board-item')).toHaveCount(2)
  await expect(panel).toHaveScreenshot('setup-saved-boards.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})
