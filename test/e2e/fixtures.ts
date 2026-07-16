import { expect, test as base } from '@playwright/test'

type UiFixtures = {
  pageErrors: Error[]
}

export const test = base.extend<UiFixtures>({
  pageErrors: [async ({ page }, use) => {
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    await use(errors)
    expect(errors.map((error) => error.stack ?? error.message)).toEqual([])
  }, { auto: true }],
})

export { expect, type Page } from '@playwright/test'
