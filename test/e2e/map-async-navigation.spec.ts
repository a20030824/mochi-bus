import type { Route } from '@playwright/test'
import { expect, test, type Page } from './fixtures'

const city = { code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }

function variant(routeName: string) {
  const longitudeOffset = routeName === 'A' ? 0 : .03
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `TNN-${routeName}`,
    direction: 0 as const,
    label: '臺南火車站 → 永康火車站',
    subRouteName: routeName,
    updatedAt: null,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.20 + longitudeOffset, 22.99], [120.24 + longitudeOffset, 23.02]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { stopUid: `${routeName}-1`, stopName: '臺南火車站', sequence: 1 },
          geometry: { type: 'Point' as const, coordinates: [120.20 + longitudeOffset, 22.99] as [number, number] },
        },
        {
          type: 'Feature' as const,
          properties: { stopUid: `${routeName}-2`, stopName: '永康火車站', sequence: 2 },
          geometry: { type: 'Point' as const, coordinates: [120.24 + longitudeOffset, 23.02] as [number, number] },
        },
      ],
    },
  }
}

async function mockBaseMap(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({ json: { cities: [city] } }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: 'A', category: '其他' }, { routeName: 'B', category: '其他' }] },
  }))
  await page.route('**/api/v1/map/timetable*', (route) => route.fulfill({
    json: {
      timetable: {
        mode: 'none',
        selectedStop: null,
        departureStop: null,
        stops: [],
        timedStopCount: 0,
        services: [],
      },
    },
  }))
}

function deferred() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}

async function safelyFulfill(route: Route, json: unknown) {
  try {
    await route.fulfill({ json })
  } catch {
    // 修復後 request 會被 AbortController 中止；route 已關閉就是預期結果。
  }
}

test('does not reopen a route whose loading view was cancelled', async ({ page }) => {
  await mockBaseMap(page)
  const routeResponse = deferred()
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    await routeResponse.promise
    await safelyFulfill(route, { variants: [variant('A')] })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: 'A', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: 'A', exact: true })).toBeVisible()

  await drawer.locator('.drawer-back').click()
  await expect(drawer.getByRole('heading', { name: '臺南', exact: true })).toBeVisible()

  routeResponse.release()
  await page.waitForTimeout(150)
  await expect(drawer.getByRole('heading', { name: '臺南', exact: true })).toBeVisible()
  await expect(drawer.locator('.variant-list')).toHaveCount(0)
})

test('does not resume trip selection after the user cancels a pending nearby lookup', async ({ page }) => {
  await mockBaseMap(page)
  const nearbyResponse = deferred()
  await page.route(/\/api\/v1\/map\/nearby(?:\?|$)/, async (route) => {
    await nearbyResponse.promise
    await safelyFulfill(route, {
      places: [{
        placeId: 'P1',
        name: '臺南火車站',
        latitude: 22.99,
        longitude: 120.21,
        distanceMeters: 20,
      }],
    })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.locator('.trip-mode-button').click()
  await page.locator('#map').click({ position: { x: 120, y: 160 } })
  await expect(page.locator('#map-status')).toContainText('正在尋找附近站牌')

  await drawer.getByRole('button', { name: '← 取消路線規劃', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: '臺南', exact: true })).toBeVisible()

  nearbyResponse.release()
  await page.waitForTimeout(150)
  await expect(drawer.getByRole('heading', { name: '臺南', exact: true })).toBeVisible()
  await expect(drawer.getByRole('heading', { name: '再點一下目的地', exact: true })).toHaveCount(0)
})

test('keeps the current route vehicles when an older route response finishes last', async ({ page }) => {
  await mockBaseMap(page)
  const oldVehicles = deferred()
  const oldVehicleRequested = deferred()
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => {
    const routeName = new URL(route.request().url()).searchParams.get('route') ?? 'A'
    return route.fulfill({ json: { variants: [variant(routeName)] } })
  })
  await page.route(/\/api\/v1\/map\/vehicles(?:\?|$)/, async (route) => {
    const routeUid = new URL(route.request().url()).searchParams.get('routeUid')
    if (routeUid === 'TNN-A') {
      oldVehicleRequested.release()
      await oldVehicles.promise
      await safelyFulfill(route, {
        vehicles: [{ plate: 'OLD-A', latitude: 22.995, longitude: 120.215, speed: 10, azimuth: 0, gpsTime: null }],
      })
      return
    }
    await route.fulfill({
      json: {
        vehicles: [
          { plate: 'NEW-B-1', latitude: 23.01, longitude: 120.245, speed: 12, azimuth: 0, gpsTime: null },
          { plate: 'NEW-B-2', latitude: 23.02, longitude: 120.255, speed: 14, azimuth: 0, gpsTime: null },
        ],
      },
    })
  })

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: 'A', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: 'A', exact: true })).toBeVisible()
  await oldVehicleRequested.promise

  await drawer.locator('.drawer-back').click()
  await drawer.getByRole('button', { name: 'B', exact: true }).click()
  await expect(drawer.getByRole('heading', { name: 'B', exact: true })).toBeVisible()
  await expect(page.locator('.vehicle-marker-wrap')).toHaveCount(2)

  oldVehicles.release()
  await page.waitForTimeout(150)
  await expect(page.locator('.vehicle-marker-wrap')).toHaveCount(2)
})
