import { expect, test, type Page } from '@playwright/test'

const city = {
  code: 'Taipei',
  name: '臺北',
  region: 'north',
  center: [25, 121] as [number, number],
}

const places = {
  from: { placeId: 'Taipei:camera-from', name: '起點', latitude: 25, longitude: 121 },
  to: { placeId: 'Taipei:camera-to', name: '終點', latitude: 25.012, longitude: 121.024 },
}

const routeVariant = {
  variantKey: 'Camera:0',
  routeName: 'Camera',
  routeUid: 'Camera-uid',
  direction: 0 as const,
  label: '起點 → 終點',
  subRouteName: 'Camera',
  shape: {
    type: 'Feature' as const,
    properties: { routeUid: 'Camera-uid', direction: 0 },
    geometry: {
      type: 'LineString' as const,
      coordinates: [[121, 25], [121.008, 25.004], [121.016, 25.008], [121.024, 25.012]],
    },
  },
  stops: {
    type: 'FeatureCollection' as const,
    features: [
      {
        type: 'Feature' as const,
        properties: { stopUid: 'Camera-1', stopName: '起點', sequence: 1 },
        geometry: { type: 'Point' as const, coordinates: [121, 25] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'Camera-2', stopName: '中途', sequence: 2 },
        geometry: { type: 'Point' as const, coordinates: [121.012, 25.006] as [number, number] },
      },
      {
        type: 'Feature' as const,
        properties: { stopUid: 'Camera-3', stopName: '終點', sequence: 3 },
        geometry: { type: 'Point' as const, coordinates: [121.024, 25.012] as [number, number] },
      },
    ],
  },
  updatedAt: null,
}

async function mockDirectJourney(page: Page) {
  await page.route('https://tile.openstreetmap.org/**', async (route) => {
    await route.fulfill({ status: 204 })
  })
  await page.route('**/api/v1/map/cities', async (route) => {
    await route.fulfill({ json: { cities: [city] } })
  })
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { routes: [{ routeName: 'Camera', category: '其他' }] } })
  })
  await page.route('**/api/v1/map/search*', async (route) => {
    const query = new URL(route.request().url()).searchParams.get('q')
    const place = query === '起點' ? places.from : query === '終點' ? places.to : undefined
    await route.fulfill({ json: { places: place ? [place] : [] } })
  })
  await page.route('**/api/v1/map/nearby*', async (route) => {
    const latitude = Number(new URL(route.request().url()).searchParams.get('lat'))
    const place = latitude < 25.006 ? places.from : places.to
    await route.fulfill({ json: { places: [{ ...place, distanceMeters: 0 }] } })
  })
  await page.route('**/api/v1/map/direct*', async (route) => {
    await route.fulfill({ json: { routes: [{
      routeName: 'Camera',
      variantKey: 'Camera:0',
      direction: 0,
      label: '起點 → 終點',
      subRouteName: 'Camera',
      boardSequence: 1,
      alightSequence: 3,
      stopCount: 3,
    }] } })
  })
  await page.route('**/api/v1/map/journey-eta', async (route) => {
    await route.fulfill({ json: { estimates: [{ key: 'direct:0', minutes: 5 }] } })
  })
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, async (route) => {
    await route.fulfill({ json: { variants: [routeVariant] } })
  })
}

async function openDirectJourney(page: Page) {
  await page.goto('/map?city=Taipei')
  await page.getByRole('button', { name: /路線規劃/ }).click()
  const search = page.locator('.map-search')
  await search.fill('起點')
  await page.locator('.nearby-place-button').filter({ hasText: '起點' }).click()
  await search.fill('終點')
  await page.locator('.nearby-place-button').filter({ hasText: '終點' }).click()
  await expect(page.locator('.direct-route-card')).toHaveCount(1)
  await expect(page.locator('.leaflet-tooltip').filter({ hasText: /^(上車|下車)/ })).toHaveCount(2)
}

async function cameraGeometry(page: Page) {
  return page.evaluate(() => {
    const mapRect = document.getElementById('map')!.getBoundingClientRect()
    const drawerRect = document.getElementById('map-drawer')!.getBoundingClientRect()
    const tooltipRects = Array.from(document.querySelectorAll<HTMLElement>('.leaflet-tooltip'))
      .filter((tooltip) => /^(上車|下車)/.test(tooltip.textContent ?? ''))
      .map((tooltip) => {
        const rect = tooltip.getBoundingClientRect()
        return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom }
      })
    return {
      map: { left: mapRect.left, top: mapRect.top, right: mapRect.right, bottom: mapRect.bottom },
      drawer: { left: drawerRect.left, top: drawerRect.top, right: drawerRect.right, bottom: drawerRect.bottom },
      tooltips: tooltipRects,
    }
  })
}

test.describe('drawer-aware map camera padding', () => {
  test('keeps journey endpoints left of the desktop drawer', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 })
    await mockDirectJourney(page)
    await openDirectJourney(page)

    await expect.poll(async () => {
      const geometry = await cameraGeometry(page)
      return geometry.tooltips.length === 2
        && geometry.tooltips.every((tooltip) => tooltip.right <= geometry.drawer.left)
    }).toBe(true)

    const geometry = await cameraGeometry(page)
    expect(geometry.drawer.right).toBeLessThan(geometry.map.right)
    expect(geometry.tooltips.every((tooltip) => tooltip.right <= geometry.drawer.left)).toBe(true)
  })

  test('keeps journey endpoints above the mobile bottom sheet', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockDirectJourney(page)
    await openDirectJourney(page)

    await expect.poll(async () => {
      const geometry = await cameraGeometry(page)
      return geometry.tooltips.length === 2
        && geometry.tooltips.every((tooltip) => tooltip.bottom <= geometry.drawer.top)
    }).toBe(true)

    const geometry = await cameraGeometry(page)
    expect(geometry.drawer.left).toBeGreaterThan(geometry.map.left)
    expect(geometry.drawer.right).toBeLessThan(geometry.map.right)
    expect(geometry.tooltips.every((tooltip) => tooltip.bottom <= geometry.drawer.top)).toBe(true)
  })
})
