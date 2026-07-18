import { expect, test } from './fixtures'

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
    const routeDetailCalls: string[] = []
    let directResponseMode: 'two' | 'one' = 'two'

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
    await page.route(/\/api\/v1\/map\/place\/([^/?]+)\?city=Taipei$/, async (route) => {
      const placeId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1) ?? '')
      const place = placeId === places.from.placeId ? places.from : placeId === places.to.placeId ? places.to : undefined
      await route.fulfill(place ? { json: { place } } : { status: 404, json: { error: '找不到站牌' } })
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
    await expect(page).toHaveURL('/map?city=Taipei&trip=results&from=Taipei%3Afrom&to=Taipei%3Ato')
    await expect(cards.filter({ has: page.locator('[aria-pressed="true"]') })).toHaveCount(1)
    await expect(cards.nth(0).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(cards.nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => routeDetailCalls.length).toBe(2)
    await expect(page.locator('.direct-route-selected-note')).toHaveCount(0)
    const journeyLabels = page.locator('.leaflet-tooltip').filter({ hasText: /^(上車|下車) · / })
    await expect(journeyLabels).toHaveCount(2)
    await expect(page.locator('.preview-stop-dot')).toHaveCount(3)
    await expect.poll(() => cards.nth(0).evaluate((card) => getComputedStyle(card).boxShadow)).toBe('none')
    await expect.poll(async () => {
      const selectedBackground = await cards.nth(0).evaluate((card) => getComputedStyle(card).backgroundColor)
      const candidateBackground = await cards.nth(1).evaluate((card) => getComputedStyle(card).backgroundColor)
      return selectedBackground !== candidateBackground
    }).toBe(true)
    const resultHeading = page.getByRole('heading', { name: '起點 → 終點', exact: true })
    await expect(resultHeading).toBeVisible()
    const compactDetail = cards.nth(0).getByRole('button', { name: '查看 A 完整路線', exact: true })
    await expect(compactDetail).toHaveText('完整路線 ›')
    await expect.poll(() => compactDetail.evaluate((button) => getComputedStyle(button).position)).toBe('static')
    const originalViewport = page.viewportSize()!
    await page.setViewportSize({ width: 390, height: 844 })
    expect(await resultHeading.evaluate((heading) => parseFloat(getComputedStyle(heading).fontSize))).toBeLessThanOrEqual(24)
    expect(await resultHeading.evaluate((heading) => parseFloat(getComputedStyle(heading).lineHeight))).toBeGreaterThan(24)
    await page.setViewportSize(originalViewport)

    await cards.nth(1).locator('.direct-route-select').press('Enter')
    await expect(cards.nth(0).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'false')
    await expect(cards.nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('heading', { name: '起點 → 終點', exact: true })).toBeVisible()
    await expect.poll(() => routeDetailCalls.length).toBe(4)
    await expect(journeyLabels).toHaveCount(2)
    await expect(page.locator('.preview-stop-dot')).toHaveCount(3)
    await expect(page.locator('.direct-route-selected-note')).toHaveCount(0)
    await expect.poll(() => cards.nth(1).evaluate((card) => getComputedStyle(card).boxShadow)).toBe('none')

    const zoomIn = page.getByRole('button', { name: 'Zoom in', exact: true })
    await expect(zoomIn).toHaveCount(1)
    await zoomIn.click()
    await zoomIn.click()
    // Leaflet 可用不同的內部 transform 表示同一個鏡頭；比較使用者實際看見的
    // 上／下車標籤位置，才能穩定驗證從路線詳情返回時沒有搶走視角。
    const readJourneyCamera = () => journeyLabels.evaluateAll((labels) => JSON.stringify(labels.map((label) => {
      const bounds = label.getBoundingClientRect()
      return { x: Math.round(bounds.x), y: Math.round(bounds.y) }
    })))
    let cameraBeforeDetail = ''
    let stableCameraSamples = 0
    await expect.poll(async () => {
      const nextCamera = await readJourneyCamera()
      if (nextCamera === cameraBeforeDetail) stableCameraSamples += 1
      else {
        cameraBeforeDetail = nextCamera
        stableCameraSamples = 0
      }
      return stableCameraSamples
    }, {
      intervals: [100, 100, 150, 200, 250],
      timeout: 10_000,
    }).toBeGreaterThanOrEqual(3)

    await cards.nth(1).getByRole('button', { name: '查看 B 完整路線', exact: true }).click()
    await expect.poll(() => routeDetailCalls.length).toBe(5)
    expect(routeDetailCalls.at(-1)).toBe('B')
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    const backToTrip = page.getByRole('button', { name: '返回行程候選', exact: false })
    await expect(backToTrip).toHaveCount(1)
    await backToTrip.click()
    await expect(page).toHaveURL('/map?city=Taipei&trip=results&from=Taipei%3Afrom&to=Taipei%3Ato')
    await expect(page.locator('.direct-route-card')).toHaveCount(2)
    await expect(page.locator('.direct-route-card').nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(readJourneyCamera).toBe(cameraBeforeDetail)

    await page.goForward()
    await expect(page).toHaveURL(/route=B/)
    await expect(page.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
    await page.goBack()
    await expect(page).toHaveURL('/map?city=Taipei&trip=results&from=Taipei%3Afrom&to=Taipei%3Ato')
    await expect(page.locator('.direct-route-card')).toHaveCount(2)
    await page.reload()
    await expect(page.locator('.direct-route-card')).toHaveCount(2)
    await expect(page.locator('.direct-route-card').nth(1).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await page.evaluate(() => history.replaceState(null, '', location.href))
    await page.reload()
    await expect(page.locator('.direct-route-card')).toHaveCount(2)

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
  })

  test('loads the selected ninth direct candidate within the bounded preview set', async ({ page }) => {
    const previewRouteCalls: string[] = []
    const largePlaces = {
      from: { placeId: 'Taipei:large-from', name: 'Large From', latitude: 25, longitude: 121 },
      to: { placeId: 'Taipei:large-to', name: 'Large To', latitude: 25.01, longitude: 121.02 },
    }
    const directRoutes = Array.from({ length: 9 }, (_, index) => ({
      routeName: `R${index + 1}`,
      variantKey: `R${index + 1}:0`,
      direction: 0,
      label: `R${index + 1} Large route`,
      subRouteName: `R${index + 1}`,
      boardSequence: 1,
      alightSequence: 3,
      stopCount: index + 2,
    }))

    await page.route('**/api/v1/map/cities', async (route) => {
      await route.fulfill({ json: { cities: [city] } })
    })
    await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
      await route.fulfill({ json: { routes: [{ routeName: 'Mock', category: 'bus' }] } })
    })
    await page.route('**/api/v1/map/search*', async (route) => {
      const query = new URL(route.request().url()).searchParams.get('q')
      const place = query === 'Large From' ? largePlaces.from : query === 'Large To' ? largePlaces.to : undefined
      await route.fulfill({ json: { places: place ? [place] : [] } })
    })
    await page.route('**/api/v1/map/nearby*', async (route) => {
      const latitude = Number(new URL(route.request().url()).searchParams.get('lat'))
      const place = latitude < 25.005 ? largePlaces.from : largePlaces.to
      await route.fulfill({ json: { places: [{ ...place, distanceMeters: 0 }] } })
    })
    await page.route('**/api/v1/map/direct*', async (route) => {
      await route.fulfill({ json: { routes: directRoutes } })
    })
    await page.route('**/api/v1/map/journey-eta', async (route) => {
      await route.fulfill({ json: { estimates: directRoutes.map((_, index) => ({ key: `direct:${index}`, minutes: index + 5 })) } })
    })
    await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
      const routeName = new URL(route.request().url()).searchParams.get('route') ?? 'R1'
      previewRouteCalls.push(routeName)
      const routeIndex = Number(routeName.slice(1)) - 1
      await route.fulfill({ json: { variants: [routeVariant(routeName, `${routeName}:0`, routeIndex * 10)] } })
    })

    await page.goto('/map?city=Taipei')
    await page.getByRole('button', { name: /路線規劃/ }).click()
    const searchInputs = page.locator('.map-search')
    await searchInputs.first().fill('Large From')
    await page.locator('.nearby-place-button').filter({ hasText: 'Large From' }).click()
    await searchInputs.first().fill('Large To')
    await page.locator('.nearby-place-button').filter({ hasText: 'Large To' }).click()

    const cards = page.locator('.direct-route-card')
    await expect(cards).toHaveCount(9)
    await expect.poll(() => previewRouteCalls.length).toBe(8)
    expect(new Set(previewRouteCalls)).toEqual(new Set(directRoutes.slice(0, 8).map((route) => route.routeName)))

    await cards.nth(8).locator('.direct-route-select').click()
    await expect(cards.nth(8).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'true')
    await expect(cards.nth(0).locator('.direct-route-select')).toHaveAttribute('aria-pressed', 'false')
    await expect.poll(() => previewRouteCalls.length).toBe(16)
    expect(previewRouteCalls.slice(8)).toEqual(expect.arrayContaining(directRoutes.slice(0, 7).map((route) => route.routeName)))
    expect(previewRouteCalls.slice(8)).toContain('R9')
    expect(previewRouteCalls.slice(8)).not.toContain('R8')
    expect(new Set(previewRouteCalls.slice(8)).size).toBe(8)
  })
})
