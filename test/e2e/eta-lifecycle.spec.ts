import { expect, test } from './fixtures'

const board = {
  version: 2,
  id: 'visibility-board',
  title: '捷運景安站',
  city: 'NewTaipei',
  placeId: 'NWT:jing-an',
  buses: [{
    city: 'NewTaipei',
    routeName: '307',
    routeUid: 'NWT307',
    patternId: 'NWT307-0',
    stopName: '捷運景安站',
    stopUid: 'NWT1',
    direction: 0,
  }],
  createdAt: '2026-07-18T00:00:00.000Z',
  updatedAt: '2026-07-18T00:00:00.000Z',
}

test('visibility resume refreshes once and coalesces repeated visible events', async ({ page }) => {
  await page.addInitScript((savedBoard) => {
    localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([savedBoard]))
    localStorage.setItem('mochi.bus.activeBoard.v2', savedBoard.id)
  }, board)

  let arrivalsCalls = 0
  let releaseForegroundRefresh: (() => void) | undefined
  await page.route('**/api/v1/map/place/*/arrivals?*', async (route) => {
    arrivalsCalls += 1
    if (arrivalsCalls === 2) {
      await new Promise<void>((resolve) => { releaseForegroundRefresh = resolve })
    }
    await route.fulfill({ json: { routes: [{
      routeName: '307', routeUid: 'NWT307', variantKey: 'NWT307-0', direction: 0,
      label: '往板橋', stopUid: 'NWT1', stopName: '捷運景安站',
      estimateSeconds: 300, etaLabel: '5 分', source: 'realtime',
    }] } })
  })

  await page.goto('/')
  await expect.poll(() => arrivalsCalls).toBe(1)
  await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled()

  await page.evaluate(() => {
    let hidden = true
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => hidden ? 'hidden' : 'visible',
    })
    ;(window as typeof window & { setMochiTestVisibility?: (value: boolean) => void }).setMochiTestVisibility = (value) => {
      hidden = value
      document.dispatchEvent(new Event('visibilitychange'))
    }
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(arrivalsCalls).toBe(1)
  await page.evaluate(() => {
    ;(window as typeof window & { setMochiTestVisibility: (value: boolean) => void }).setMochiTestVisibility(false)
  })
  await expect.poll(() => arrivalsCalls).toBe(2)
  await expect(page.getByRole('button', { name: '更新中' })).toBeDisabled()

  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'))
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(arrivalsCalls).toBe(2)
  releaseForegroundRefresh?.()
  await expect(page.getByRole('button', { name: '重新整理' })).toBeEnabled()

  await page.getByRole('button', { name: '重新整理' }).click()
  await expect.poll(() => arrivalsCalls).toBe(3)
})
