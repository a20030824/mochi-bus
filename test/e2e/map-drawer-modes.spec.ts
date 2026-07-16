import { expect, test, type Page } from '@playwright/test'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }
const routeNames = ['0右', '0左', ...Array.from({ length: 179 }, (_, index) => String(index + 1))]
// 直接重現回報中的兩種長列表：181 條路線與 29 個行車方向。

function variant(routeName: string) {
  return {
    variantKey: `${routeName}:0`, routeName, routeUid: `TNN-${routeName}`, direction: 0 as const,
    label: '臺南火車站 → 永康火車站', subRouteName: routeName, updatedAt: null,
    shape: { type: 'Feature' as const, properties: {}, geometry: { type: 'LineString' as const, coordinates: [[120.20, 22.99], [120.24, 23.02]] } },
    stops: { type: 'FeatureCollection' as const, features: [
      { type: 'Feature' as const, properties: { stopUid: 'S1', stopName: '臺南火車站', sequence: 1 }, geometry: { type: 'Point' as const, coordinates: [120.20, 22.99] as [number, number] } },
      { type: 'Feature' as const, properties: { stopUid: 'S2', stopName: '永康火車站', sequence: 2 }, geometry: { type: 'Point' as const, coordinates: [120.24, 23.02] as [number, number] } },
    ] },
  }
}

function arrivals() {
  return Array.from({ length: 29 }, (_, index) => ({
    routeName: `路線${String(index + 1).padStart(2, '0')}`,
    routeUid: `ARR-${index + 1}`,
    variantKey: `ARR-${index + 1}:0`,
    direction: 0 as const,
    label: `終點${index + 1} → 臺南火車站`,
    subRouteUid: `ARR-${index + 1}`,
    subRouteName: `路線${index + 1}`,
    stopUid: 'P1-S',
    stopName: '臺南火車站(成功路A)',
    stopSequence: 1,
    estimateSeconds: index === 0 ? 540 : null,
    etaLabel: index === 0 ? '9 分後發車' : `明日 05:${String(40 + (index % 20)).padStart(2, '0')} 發車`,
    stopStatus: 0,
    source: index === 0 ? 'realtime' as const : 'schedule' as const,
  }))
}

async function mockMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: routeNames.map((routeName, index) => ({ routeName, category: index % 4 === 0 ? '幹線' : '數字' })) },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? '0右'
    return route.fulfill({ json: { variants: [variant(routeName)] } })
  })
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: { timetable: { mode: 'none', selectedStop: null, departureStop: null, stops: [], timedStopCount: 0, services: [] } },
  }))
  await page.route('**/api/v1/map/place/P1?city=Tainan', (route) => route.fulfill({
    json: { place: { placeId: 'P1', name: '臺南火車站(成功路A)', latitude: 22.997, longitude: 120.212, distanceMeters: 101 } },
  }))
  await page.route('**/api/v1/map/place/P1/arrivals?city=Tainan', (route) => route.fulfill({ json: { routes: arrivals() } }))
}

async function drawerMetrics(page: Page) {
  return page.locator('#map-drawer').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return {
      height: rect.height,
      viewportHeight: window.innerHeight,
      outerClientHeight: element.clientHeight,
      outerScrollHeight: element.scrollHeight,
    }
  })
}

test('keeps the city route catalogue below half the map with one internal scroller', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  const region = drawer.locator(':scope > .drawer-scroll-region')
  await expect(region).toHaveCount(1)
  await expect(drawer.getByRole('button', { name: '全部', exact: true })).toBeVisible()
  const controls = await drawer.evaluate((element) => {
    const searchRect = element.querySelector<HTMLElement>('.map-search')!.getBoundingClientRect()
    const categoriesRect = element.querySelector<HTMLElement>('.map-categories')!.getBoundingClientRect()
    const chipRect = element.querySelector<HTMLElement>('.map-chip')!.getBoundingClientRect()
    const regionRect = element.querySelector<HTMLElement>(':scope > .drawer-scroll-region')!.getBoundingClientRect()
    return {
      searchHeight: searchRect.height,
      categoriesHeight: categoriesRect.height,
      chipTopGap: chipRect.top - categoriesRect.top,
      chipBottomGap: categoriesRect.bottom - chipRect.bottom,
      regionTopGap: regionRect.top - categoriesRect.bottom,
    }
  })
  expect(controls.searchHeight).toBeGreaterThanOrEqual(38)
  expect(controls.categoriesHeight).toBeGreaterThanOrEqual(28)
  expect(controls.chipTopGap).toBeGreaterThanOrEqual(-1)
  expect(controls.chipBottomGap).toBeGreaterThanOrEqual(-1)
  expect(controls.regionTopGap).toBeGreaterThanOrEqual(0)
  await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight + 4)).toBe(true)

  const metrics = await drawerMetrics(page)
  expect(metrics.height).toBeLessThanOrEqual(metrics.viewportHeight * 0.5 + 3)
  expect(metrics.outerScrollHeight).toBeLessThanOrEqual(metrics.outerClientHeight + 1)

  const before = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => region.evaluate((element) => element.scrollTop > 0)).toBe(true)
  const after = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  expect(Math.abs(after.backTop - before.backTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1)

  const gridMetrics = await drawer.locator('.map-route-grid').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    overflowY: getComputedStyle(element).overflowY,
  }))
  expect(gridMetrics.scrollHeight).toBeGreaterThan(gridMetrics.clientHeight)
  expect(gridMetrics.overflowY).not.toMatch(/auto|scroll/)

  await region.evaluate((element) => { element.scrollTop = 0 })
  await drawer.getByRole('button', { name: '0右', exact: true }).click()
  await expect(drawer).toHaveAttribute('data-mode', 'compact')
  await expect(drawer.getByRole('heading', { name: '0右' })).toBeVisible()
  await drawer.locator(':scope > .drawer-back').click()
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator(':scope > .drawer-scroll-region')).toHaveJSProperty('scrollTop', 0)
})

test('keeps a 29-direction stop list compact while its header remains visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await mockMap(page)
  await page.goto('/map?city=Tainan&place=P1')

  const drawer = page.locator('#map-drawer')
  await expect(drawer.getByRole('heading', { name: '臺南火車站(成功路A)' })).toBeVisible()
  await expect(drawer.locator('.drawer-heading p')).toContainText('29 個行車方向')
  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.locator('.place-route-row')).toHaveCount(29)
  const region = drawer.locator(':scope > .drawer-scroll-region')
  await expect(region).toHaveCount(1)
  await expect.poll(() => region.evaluate((element) => element.scrollHeight > element.clientHeight + 4)).toBe(true)

  const metrics = await drawerMetrics(page)
  expect(metrics.height).toBeLessThanOrEqual(metrics.viewportHeight * 0.5 + 3)
  expect(metrics.outerScrollHeight).toBeLessThanOrEqual(metrics.outerClientHeight + 1)

  const before = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  await region.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => region.evaluate((element) => element.scrollTop > 0)).toBe(true)
  const after = await drawer.evaluate((element) => ({
    backTop: element.querySelector('.drawer-back')!.getBoundingClientRect().top,
    headingTop: element.querySelector('.drawer-heading')!.getBoundingClientRect().top,
  }))
  expect(Math.abs(after.backTop - before.backTop)).toBeLessThanOrEqual(1)
  expect(Math.abs(after.headingTop - before.headingTop)).toBeLessThanOrEqual(1)
})
