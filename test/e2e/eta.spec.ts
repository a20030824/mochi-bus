import { expect, test } from '@playwright/test'

const board = {
  version: 2,
  id: 'stored-board',
  title: '嘉義火車站',
  city: 'Chiayi',
  placeId: 'chiayi-station',
  buses: [{
    city: 'Chiayi',
    routeName: '7322',
    routeUid: 'CYI7322',
    patternId: 'CYI7322-0',
    stopName: '嘉義火車站',
    stopUid: 'CYI001',
    direction: 0,
  }],
  createdAt: '2026-07-13T00:00:00.000Z',
  updatedAt: '2026-07-13T00:00:00.000Z',
}

const eta = (routeName: string, estimateSeconds: number) => ({
  routeName,
  stopName: '嘉義火車站',
  stopUid: 'CYI001',
  direction: 0,
  estimateSeconds,
  minutes: Math.ceil(estimateSeconds / 60),
  label: `${Math.ceil(estimateSeconds / 60)} 分`,
  stopStatus: 0,
  statusLabel: '正常',
  dataTime: '2026-07-13T07:00:00+08:00',
  fetchedAt: '2026-07-13T07:00:01+08:00',
  stale: false,
  source: 'realtime',
})

test.describe('ETA page', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/v1/eta*', async (route) => {
      const routeName = new URL(route.request().url()).searchParams.get('route') || '7322'
      await route.fulfill({ json: eta(routeName, routeName === '7322' ? 120 : 60) })
    })
  })

  test('homepage demo board does not persist demo data and has no page error', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.goto('/')
    await expect(page.locator('#onboard')).toBeVisible()
    await expect(page.locator('#onboard-sign')).toBeVisible()
    await expect(page.locator('script[src="/assets/eta.js"]')).toHaveCount(1)
    await expect(page.locator('#eta-bootstrap')).toBeAttached()
    expect(await page.evaluate(() => localStorage.getItem('mochi.bus.boards.v2'))).toBe('[]')
    expect(pageErrors).toEqual([])
  })

  test('homepage uses a stored board, updates its map link, and refreshes ETA', async ({ page }) => {
    let refreshCalls = 0
    await page.route('**/api/v1/map/place/**', async (route) => {
      refreshCalls += 1
      await route.fulfill({ json: { routes: [] } })
    })
    await page.addInitScript((storedBoard) => {
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([storedBoard]))
      localStorage.setItem('mochi.bus.activeBoard.v2', storedBoard.id)
    }, board)

    await page.goto('/')
    await expect(page.locator('#board-title')).toHaveText('嘉義火車站')
    await expect(page.locator('.bus-name')).toHaveText('7322')
    await expect(page.locator('.top-actions a').first()).toHaveAttribute('href', '/map?city=Chiayi&place=chiayi-station')
    await expect.poll(() => refreshCalls).toBeGreaterThan(0)
    await expect.poll(async () => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration()))).toBe(true)
  })

  test('shared /bus page is not overridden by local boards', async ({ page }) => {
    await page.addInitScript((storedBoard) => {
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([storedBoard]))
      localStorage.setItem('mochi.bus.activeBoard.v2', storedBoard.id)
    }, board)

    await page.goto('/bus?city=Taipei&route=307&direction=0&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99&stopUid=TPE213044&routeUid=TPE19108')
    await expect(page.locator('#board-title')).toHaveText('307 在 捷運西門站 的到站時間')
    await expect(page.locator('#onboard')).toBeHidden()
  })

  test('refresh disables the button and sorts rows by ETA', async ({ page }) => {
    const boardWithoutPlace = { ...board, placeId: undefined }
    await page.addInitScript((storedBoard) => {
      const secondBus = { ...storedBoard.buses[0], routeName: '7323', routeUid: 'CYI7323', patternId: 'CYI7323-0' }
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([{ ...storedBoard, buses: [...storedBoard.buses, secondBus] }]))
      localStorage.setItem('mochi.bus.activeBoard.v2', storedBoard.id)
    }, boardWithoutPlace)
    await page.route('**/api/v1/stops*', async (route) => {
      await route.fulfill({ json: { groups: [] } })
    })
    await page.route('**/api/v1/eta*', async (route) => {
      const routeName = new URL(route.request().url()).searchParams.get('route') || '7322'
      await new Promise((resolve) => setTimeout(resolve, 150))
      await route.fulfill({ json: eta(routeName, routeName === '7322' ? 120 : 60) })
    })

    await page.goto('/')
    await expect(page.locator('#refresh')).toBeEnabled()
    await page.locator('#refresh').click()
    await expect(page.locator('#refresh')).toBeDisabled()
    await expect(page.locator('#refresh')).toHaveText('重新整理')
    await expect(page.locator('.bus-name').first()).toHaveText('7323')
  })
})
