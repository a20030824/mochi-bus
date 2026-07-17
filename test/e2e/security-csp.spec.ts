import { expect, test } from './fixtures'

test('keeps setup and map resources inside the report-only CSP allowlist', async ({ page }) => {
  const violations: Array<{ directive: string; blocked: string }> = []
  await page.exposeFunction('captureCspViolation', (violation: { directive: string; blocked: string }) => {
    violations.push(violation)
  })
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      if (event.disposition !== 'report') return
      void (window as unknown as {
        captureCspViolation: (violation: { directive: string; blocked: string }) => Promise<void>
      }).captureCspViolation({
        directive: event.effectiveDirective,
        blocked: event.blockedURI,
      })
    })
  })

  await page.goto('/setup')
  await expect(page.locator('h1')).toHaveText('常用站牌')
  await page.goto('/map')
  await expect(page.locator('#map')).toBeVisible()
  await page.waitForTimeout(500)

  expect(violations).toEqual([])
})
