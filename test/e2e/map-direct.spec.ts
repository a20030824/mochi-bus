import { expect, test } from '@playwright/test'

const city = {
  code: 'Taipei',
  name: '臺北',
  region: 'north',
  center: [25, 121] as [number, number],
}

const places = {
  from: {
    placeId: 'Taipei:from',
    name: '起點',
    latitude: 25,
    longitude: 121,
  },
  to: {
    placeId: 'Taipei:to',
    name: '終點',
    latitude: 25.01,
    longitude: 121.02,
  },
}

function routeVariant(routeName: string, variantKey: string, offset: number) {
  return {
    variantKey,
    routeName,
    routeUid: `${routeName}-uid`,
    direction: 0,
    label: `${routeName} 起點 → 終點`,
    subRouteName: routeName,
    shape: {
      type: 'Feature' as const,
      properties: { routeUid: `${routeName}-uid`, direction: 0 },
      geometry: {
        type: 'LineString' as const,
        coordinates: [[offset, 0], [offset + 1, 0], [offset + 2, 0], [offset + 3, 0]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [1, 2, 3].map((sequence) => ({
        type: 'Feature' as const,
        properties: { stopUid: `${routeName}-${sequence}`, stopName: `站牌 ${sequence}`, sequence },
        geometry: { type: 'Point' as const, coordinates: [offset + sequence - 1, 0] as [number, number] },
      })),
    },
    updatedAt: null,
  }
}

test.describe('direct journey candidate selection', () => {
  test('selects candidates without opening route detail, supports keyboard, and opens detail explicitly', async ({ page }) => {
    const pageErrors: string[] = []
    const routeDetailCalls: string[] = []
    let directResponseMode: 'two' | 'one' = 'two'
    page.on('pageerror', (error) => pageErrors.push(error.message))

    await page.route('**/api/v1/map/cities', async (route) => {
      await route.fulfill({ json: { cities: [city] } })
    })
    await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
      await route.fulfill({ json: { routes: [{ routeName: 'Mock', category: '其他' }] } })
    })
    await page.route('**/api/v1/map/search*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q')
      const place = query === '起點' ? places.from : query === '終點' ? places.to : undefined
      await route.fulfill({ json: { places: place ? [place] : [] } })
    })
    await page.route('**/api/v1/map/nearby*', async (route) => {
      const latitude = Number(new URL(route.request().url()).searchParams.get('lat'))
      const place = latitude < 25.005 ? places.from : places.to
      await route.fulfill({ json: { places: [{ ...place, distanceMeters: 0 }] } })
    })
    await page.route('**/api/v1/map/direct*', async (route) => {
      const routes = directResponseMode === 'one'
        ? [{ routeName: 'B', variantKey: 'B:0', direction: 0, label: 'B 起點 → 終點', subRouteName: 'B', boardSequence: 1, alightSequence: 3, stopCount: 3 }]
        : [
            { routeName: 'A', variantKey: 'A:0', direction: 0, label: 'A 起點 → 終點', subRouteName: 'A', boardSequence: 1, alightSequence: 3, stopCount: 2 },
            { routeName: 'B', variantKey: 'B:0', direction: 0, label: 'B 起點 → 終點', subRouteName: 'B', boardSequence: 1, alightSequence: 3, stopCount: 3 },
          ]
      await route.fulfill({ json: {
        routes,
      } })
    })
    await page.route('**/api/v1/map/journey-eta', async (route) => {
      await route.fulfill({ json: { estimates: [
        { key: 'direct:0', minutes: 5 },
        { key: 'direct:1', minutes: 8 },
      ] } })
    })
    await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
      const routeName = new URL(route.request().url()).searchParams.get('route') || 'A'
      routeDetailCalls.push(routeName)
      const variant = routeVariant(routeName, `${routeName}:0`, routeName === 'A' ? 0 : 10)
      await route.fulfill({ json: { variants: [variant] } })
    })

    await page.goto('/map?city=Taipei')
    await page.getByRole('button', { name: '路線規劃：選擇出發位置與目的地' }).click()
    await page.getByRole('textbox', { name: '搜尋出發站牌' }).fill('起點')
    await page.getByRole('button', { name: '起點 站牌', exact: true }).click()
    await page.getByRole('textbox', { name: '搜尋目的地站牌' }).fill('終點')
    await page.getByRole('button', { name: '終點 站牌', exact: true }).click()

    const cards = page.locator('.direct-route-card')
    await expect(cards).toHaveCount(2)
    await expect(cards.filter({ has: page.locator('[aria-pressed="true"]') })).toHaveCount(1)
    await expect(cards.nth(0).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(cards.nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'false')
    await expect(page.getByRole('heading', { name: '起點 → 終點', exact: true })).toBeVisible()

    await cards.nth(1).locator('.direct-route-select').press('Enter')
    await expect(cards.nth(0).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'false')
    await expect(cards.nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: '起點 → 終點', exact: true })).toBeVisible()
    await expect.poll(() => routeDetailCalls.length).toBe(4)

    await cards.nth(1).getByRole('button', { name: '查看 B 完整路線', exact: true }).click()
    await expect.poll(() => routeDetailCalls.length).toBe(5)
    expect(routeDetailCalls.at(-1)).toBe('B')
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    const backToTrip = page.getByRole('button', { name: '返回行程候選', exact: false })
    await expect(backToTrip).toHaveCount(1)
    await backToTrip.click()
    await expect(page.locator('.direct-route-card')).toHaveCount(2)
    await expect(page.locator('.direct-route-card').nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')

    directResponseMode = 'one'
    var chooseDestinationAgain = page.getByRole('button', { name: '重新選目的地', exact: false })
    await expect(chooseDestinationAgain).toHaveCount(1)
    await chooseDestinationAgain.click()
    var destinationSearch = page.getByRole('textbox', { name: '搜尋目的地站牌' })
    await expect(destinationSearch).toHaveCount(1)
    await destinationSearch.fill('終點')
    var destinationResult = page.getByRole('button', { name: '終點 站牌', exact: true })
    await expect(destinationResult).toHaveCount(1)
    await destinationResult.click()
    await expect(page.locator('.direct-route-card')).toHaveCount(1)
    await expect(page.locator('.direct-route-card').locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    expect(pageErrors).toEqual([])
  })
})
