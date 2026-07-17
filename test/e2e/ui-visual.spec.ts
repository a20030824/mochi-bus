import { expect, test } from './fixtures'

test('softens marquee text at the fixed sign edges', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')

  const sign = page.locator('#onboard-sign')
  await expect(sign).toBeVisible()
  const edgeOverlay = await sign.evaluate((element) => {
    const style = getComputedStyle(element, '::before')
    return { backgroundImage: style.backgroundImage, pointerEvents: style.pointerEvents }
  })
  expect(edgeOverlay.backgroundImage).toContain('32px')
  expect(edgeOverlay.pointerEvents).toBe('none')
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
  await expect(panel.locator('.advanced-panel > summary')).toHaveCSS('color', 'rgb(119, 112, 102)')
  await expect(panel.locator('.about-panel > summary')).toHaveCSS('color', 'rgb(119, 112, 102)')
  await expect(panel).toHaveScreenshot('setup-empty-state.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})
