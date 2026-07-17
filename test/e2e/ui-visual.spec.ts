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
  await expect(panel.locator('.advanced-panel > summary')).toHaveCSS('color', 'rgb(119, 112, 102)')
  await expect(panel.locator('.about-panel > summary')).toHaveCSS('color', 'rgb(119, 112, 102)')
  await expect(panel).toHaveScreenshot('setup-empty-state.png', {
    animations: 'disabled',
    caret: 'hide',
  })
})
