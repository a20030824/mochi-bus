import { expect, test } from './fixtures'

function variant(index: number) {
  return {
    variantKey: `TNN-15:${index}`,
    routeName: '15',
    routeUid: 'TNN-15',
    direction: (index % 2) as 0 | 1,
    label: index % 2 === 0 ? '奇美醫院 → 大成路口' : '大成路口 → 奇美醫院',
    subRouteName: `15 支線 ${index + 1}`,
    updatedAt: null,
    shape: {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[120.20 + index * .002, 22.99], [120.24, 23.02 + index * .002]],
      },
    },
    stops: {
      type: 'FeatureCollection' as const,
      features: [
        {
          type: 'Feature' as const,
          properties: { stopUid: `S${index}-1`, stopName: '奇美醫院', sequence: 1 },
          geometry: { type: 'Point' as const, coordinates: [120.20 + index * .002, 22.99] as [number, number] },
        },
        {
          type: 'Feature' as const,
          properties: { stopUid: `S${index}-2`, stopName: '大成路口', sequence: 2 },
          geometry: { type: 'Point' as const, coordinates: [120.24, 23.02 + index * .002] as [number, number] },
        },
      ],
    },
  }
}

test('keeps the multi-variant back action at the drawer left edge', async ({ page }) => {
  await page.setViewportSize({ width: 420, height: 480 })
  await page.route('https://tile.openstreetmap.org/**', (route) => route.fulfill({ status: 204 }))
  await page.route('**/api/v1/map/cities', (route) => route.fulfill({
    json: { cities: [{ code: 'Tainan', name: '臺南', region: 'south', center: [22.99, 120.21] }] },
  }))
  await page.route(/\/api\/v1\/map\/routes(?:\?|$)/, (route) => route.fulfill({
    json: { routes: [{ routeName: '15', category: '數字' }] },
  }))
  await page.route(/\/api\/v1\/map\/route(?:\?|$)/, (route) => route.fulfill({
    json: { variants: Array.from({ length: 4 }, (_, index) => variant(index)) },
  }))

  await page.goto('/map?city=Tainan')
  const drawer = page.locator('#map-drawer')
  await drawer.getByRole('button', { name: '15', exact: true }).click()

  await expect(drawer).toHaveAttribute('data-mode', 'map-list')
  await expect(drawer.getByRole('heading', { name: '15' })).toBeVisible()
  await expect(drawer.locator('.variant-button')).toHaveCount(4)
  await expect(drawer.locator(':scope > .drawer-scroll-shell > .drawer-scroll-region > .variant-list')).toHaveCount(1)

  const back = drawer.getByRole('button', { name: '← 返回路線', exact: true })
  await expect(back).toBeVisible()
  const geometry = await drawer.evaluate((element) => {
    const drawerRect = element.getBoundingClientRect()
    const backNode = element.querySelector<HTMLElement>(':scope > .drawer-back')!
    const backRect = backNode.getBoundingClientRect()
    return {
      leftGap: backRect.left - drawerRect.left,
      paddingLeft: Number.parseFloat(getComputedStyle(element).paddingLeft),
      rightGap: drawerRect.right - backRect.right,
      widthRatio: backRect.width / drawerRect.width,
      alignSelf: getComputedStyle(backNode).alignSelf,
      textAlign: getComputedStyle(backNode).textAlign,
    }
  })

  expect(Math.abs(geometry.leftGap - geometry.paddingLeft)).toBeLessThanOrEqual(1)
  expect(geometry.rightGap).toBeGreaterThan(150)
  expect(geometry.widthRatio).toBeLessThan(.5)
  expect(geometry.alignSelf).toBe('flex-start')
  expect(geometry.textAlign).toBe('left')

  await back.click()
  await expect(drawer.getByRole('heading', { name: '臺南' })).toBeVisible()
})
