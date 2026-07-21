import { expect, test as base } from '@playwright/test'

type WorkerStateFixtures = {
  pageErrors: Error[]
  resetWorkerState: void
}

export const test = base.extend<WorkerStateFixtures>({
  pageErrors: [async ({ page }, use) => {
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    await use(errors)
    expect(errors.map((error) => error.stack ?? error.message)).toEqual([])
  }, { auto: true }],
  resetWorkerState: [async ({ request }, use) => {
    const response = await request.post('/__test/tdx-state/reset')
    expect(response.status()).toBe(204)
    expect(response.headers()['cache-control']).toBe('no-store')
    await use()
  }, { auto: true }],
})

export { expect } from '@playwright/test'
