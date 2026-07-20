import { expect, test, type Page } from './fixtures'

// Regression: directionLabel is optional display text. Its absence must never be treated
// as proof that a multi-route board is corrupt or used to delete local user data.
async function mockMultiRouteSetup(page: Page) {
  await page.route('**/api/v1/routes?*', (route) => route.fulfill({ json: {
    routes: [{
      routeName: '307',
      category: '數字',
      routeUid: 'NWT307',
      departure: '板橋',
      destination: '撫遠街',
    }],
  } }))
  await page.route('**/api/v1/stops?*', (route) => route.fulfill({ json: {
    groups: [{
      label: '往板橋',
      subRouteName: '307',
      routeUid: 'NWT307',
      subRouteUid: 'NWT307-0',
      direction: 0,
      stops: [{ stopUid: 'NWT1', stopName: '捷運景安站', sequence: 1 }],
    }],
  } }))
  await page.route('**/api/v1/stop-routes?*', (route) => route.fulfill({ json: {
    place: {
      placeId: 'NWT:jing-an',
      name: '捷運景安站',
      latitude: 24.993,
      longitude: 121.505,
    },
    buses: [{
      city: 'NewTaipei',
      routeName: '918',
      routeUid: 'NWT918',
      stopName: '捷運景安站',
      stopUid: 'NWT1',
      direction: 0,
      label: '5 分',
    }],
  } }))
  await page.route('**/api/v1/map/place/**', (route) => route.fulfill({ json: { routes: [] } }))
}

test.describe('setup multi-route board persistence', () => {
  test('keeps a board after adding more than one route and reloading the homepage', async ({ page }) => {
    await mockMultiRouteSetup(page)

    await page.goto('/setup')
    await page.click('#add-board-button')
    await page.locator('#city').selectOption('NewTaipei')
    await page.locator('.route-choice').first().click()
    await page.locator('#direction-step .result-card').first().locator('button.primary').click()

    const suggestion = page.locator('#suggestion-step .check-row').filter({ hasText: '918' })
    await suggestion.locator('input[type="checkbox"]').check()
    await page.getByRole('button', { name: '加入常用站牌' }).click()

    await expect(page).toHaveURL('/')
    await expect(page.locator('#bus-list > a')).toHaveCount(2)
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('mochi.bus.boards.v2') || '[]',
    ))).toMatchObject([{
      title: '捷運景安站',
      buses: [{ routeName: '307' }, { routeName: '918' }],
    }])

    await page.reload()
    await expect(page.locator('#bus-list > a')).toHaveCount(2)
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('mochi.bus.boards.v2') || '[]',
    ))).toHaveLength(1)
  })

  test('does not delete an existing multi-route board only because direction labels are missing', async ({ page }) => {
    const board = {
      version: 2,
      id: 'multi-route-without-labels',
      title: '捷運景安站',
      city: 'NewTaipei',
      placeId: 'NWT:jing-an',
      buses: [
        { city: 'NewTaipei', routeName: '307', routeUid: 'NWT307', stopName: '捷運景安站', stopUid: 'NWT1', direction: 0 },
        { city: 'NewTaipei', routeName: '918', routeUid: 'NWT918', stopName: '捷運景安站', stopUid: 'NWT1', direction: 0 },
      ],
      createdAt: '2026-07-20T00:00:00.000Z',
      updatedAt: '2026-07-20T00:00:00.000Z',
    }
    await page.addInitScript((savedBoard) => {
      localStorage.setItem('mochi.bus.boards.v2', JSON.stringify([savedBoard]))
      localStorage.setItem('mochi.bus.activeBoard.v2', savedBoard.id)
    }, board)
    await page.route('**/api/v1/map/place/**', (route) => route.fulfill({ json: { routes: [] } }))

    await page.goto('/')

    await expect(page.locator('#bus-list > a')).toHaveCount(2)
    await expect.poll(() => page.evaluate(() => JSON.parse(
      localStorage.getItem('mochi.bus.boards.v2') || '[]',
    ))).toHaveLength(1)
  })
})
