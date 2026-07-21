import { expect, test, type Page } from './fixtures'

const variant = {
  variantKey: 'CHI-7211:0',
  routeName: '7211',
  routeUid: 'CHI7211',
  subRouteUid: 'CHI-7211',
  direction: 0 as const,
  label: '嘉義公園 → 朴子轉運站',
  subRouteName: '7211',
  updatedAt: null,
  shape: {
    type: 'Feature' as const,
    properties: { routeUid: 'CHI7211', direction: 0 },
    geometry: {
      type: 'LineString' as const,
      coordinates: [[120.45, 23.48], [120.44, 23.46], [120.24, 23.46]],
    },
  },
  stops: {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 },
        geometry: { type: 'Point' as const, coordinates: [120.45, 23.48] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 },
        geometry: { type: 'Point' as const, coordinates: [120.44, 23.46] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3 },
        geometry: { type: 'Point' as const, coordinates: [120.24, 23.46] as [number, number] },
      },
    ],
  },
}

function timetable(stopUid: string | null) {
  const selected = stopUid === 'C2'
    ? { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 }
    : { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 }
  const minute = stopUid === 'C2' ? '12' : '00'
  return {
    schemaVersion: 1,
    city: 'ChiayiCounty',
    routeName: '7211',
    variantKey: variant.variantKey,
    routeUid: variant.routeUid,
    direction: 0,
    source: 'snapshot',
    timetable: {
      mode: 'stop',
      selectedStop: selected,
      departureStop: { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 },
      timedStopCount: 3,
      stops: [
        { stopUid: 'C1', stopName: '嘉義公園', sequence: 1, hasTimes: true },
        { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2, hasTimes: true },
        { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3, hasTimes: true },
      ],
      services: [{
        id: 'daily',
        label: '每日',
        days: [0, 1, 2, 3, 4, 5, 6],
        today: true,
        times: [`06:${minute}`, `08:${minute}`],
        periods: [],
        firstTime: `06:${minute}`,
        lastTime: `08:${minute}`,
      }],
    },
  }
}

async function mockPlaceEntry(page: Page, timetableStops: Array<string | null>) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({
    json: { cities: [{ code: 'ChiayiCounty', name: '嘉義縣', region: 'south', center: [23.46, 120.35] }] },
  }))
  await page.route('**/api/v1/map/routes?*', (route) => route.fulfill({
    json: { routes: [{ routeName: '7211', category: '公路客運' }] },
  }))
  await page.route(/\/api\/v1\/map\/place\/PLACE\?city=/, (route) => route.fulfill({
    json: {
      place: {
        placeId: 'PLACE',
        name: '嘉義火車站',
        latitude: 23.46,
        longitude: 120.44,
        distanceMeters: 0,
      },
    },
  }))
  await page.route(/\/api\/v1\/map\/place\/PLACE\/arrivals\?city=/, (route) => route.fulfill({
    json: {
      routes: [{
        routeUid: variant.routeUid,
        routeName: variant.routeName,
        variantKey: variant.variantKey,
        direction: variant.direction,
        label: variant.label,
        subRouteUid: variant.subRouteUid,
        subRouteName: variant.subRouteName,
        stopUid: 'C2',
        stopName: '嘉義火車站',
        stopSequence: 2,
        estimateSeconds: 300,
        etaLabel: '5 分',
        stopStatus: 0,
        source: 'realtime',
      }],
    },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({ json: { variants: [variant] } }))
  await page.route('**/api/v1/map/vehicles*', (route) => route.fulfill({ json: { vehicles: [] } }))
  await page.route('**/api/v1/map/timetable*', (route) => {
    const stopUid = new URL(route.request().url()).searchParams.get('stopUid')
    timetableStops.push(stopUid)
    return route.fulfill({ json: timetable(stopUid) })
  })
}

test('opens and restores a route timetable at the stop selected from a place', async ({ page }) => {
  const timetableStops: Array<string | null> = []
  await mockPlaceEntry(page, timetableStops)
  await page.goto('/map?city=ChiayiCounty&place=PLACE')

  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: /7211/ }).click()
  await expect(page).toHaveURL(/route=7211.*stopUid=C2/)
  await expect(drawer.locator('.route-service-summary')).toBeEnabled()
  await drawer.getByRole('button', { name: '查看時刻表' }).click()

  const stopSelect = drawer.getByRole('combobox', { name: '站牌' })
  await expect(stopSelect).toHaveValue('C2')
  await expect(drawer.locator('.timetable-overview')).toContainText('嘉義火車站')
  expect(timetableStops.at(-1)).toBe('C2')

  await page.reload()
  await expect(drawer.locator('.route-service-summary')).toBeEnabled()
  await drawer.getByRole('button', { name: '查看時刻表' }).click()
  await expect(drawer.getByRole('combobox', { name: '站牌' })).toHaveValue('C2')
  expect(timetableStops.at(-1)).toBe('C2')
})
