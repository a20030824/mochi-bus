import { expect, test } from './fixtures'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'

const routeUrl = '/route?city=Taipei&route=307&routeUid=TPE19108&direction=0&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99&stopUid=TPE213044'

const routeHtml = `<!doctype html><html><body>
<main class="route-page">
  <ol class="route-timeline">
    <li class="route-stop"><span class="dot"></span><div><strong>板橋公車站</strong></div><span class="route-eta muted"></span></li>
    <li class="route-stop selected"><span class="dot"></span><div><strong>捷運西門站</strong><em>你的站牌</em></div><span class="route-eta muted">更新中</span></li>
  </ol>
</main>
<script type="module" src="/assets/route.js"></script>
</body></html>`

const realtime = {
  schemaVersion: 1,
  eta: { kind: 'realtime' },
  stops: [
    { stopUid: 'TPE100', stopName: '板橋公車站', sequence: 1, etaLabel: '12 分', etaTone: 'live' },
    { stopUid: 'TPE213044', stopName: '捷運西門站', sequence: 2, etaLabel: '即將進站', etaTone: 'urgent' },
  ],
}

test.describe('Route progressive ETA', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/route?*', (route) => route.fulfill({
      contentType: 'text/html; charset=utf-8',
      body: routeHtml,
    }))
  })

  test('hydrates the static station order through the route ETA API', async ({ page }) => {
    let apiUrl: URL | undefined
    await page.route('**/api/v1/route-eta*', (route) => {
      apiUrl = new URL(route.request().url())
      return route.fulfill({ json: realtime })
    })

    await page.goto(routeUrl)

    const rows = page.locator('.route-stop')
    const selectedEta = rows.nth(1).locator('.route-eta')
    await expect(rows.nth(0).locator('.route-eta')).toHaveText('12 分')
    await expect(rows.nth(0).locator('.route-eta')).toHaveClass(/live/)
    await expect(selectedEta).toHaveText('即將進站')
    await expect(selectedEta).toHaveClass(/urgent/)
    await expect(selectedEta).toHaveAttribute('aria-live', 'polite')
    await expect(selectedEta).toHaveAttribute('aria-atomic', 'true')
    expect(apiUrl?.pathname).toBe('/api/v1/route-eta')
    expect(apiUrl?.searchParams.get('routeUid')).toBe('TPE19108')
    expect(apiUrl?.searchParams.get('stopUid')).toBe('TPE213044')
  })

  test('keeps the station order and exposes personal-token recovery', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({
      status: 401,
      json: { code: TDX_ACCESS_TOKEN_REJECTED_CODE, error: 'TDX 授權已失效' },
    }))

    await page.goto(routeUrl)

    const selectedEta = page.locator('.route-stop.selected .route-eta')
    await expect(page.locator('.route-stop')).toHaveCount(2)
    await expect(selectedEta).toHaveText('憑證失效')
    await expect(selectedEta).toHaveClass(/muted/)
  })

  test('rejects mismatched route identities before painting any ETA row', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({
      json: {
        ...realtime,
        stops: realtime.stops.map((stop, index) => index === 1 ? { ...stop, stopName: '錯誤站牌' } : stop),
      },
    }))

    await page.goto(routeUrl)

    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
  })
})
