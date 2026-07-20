import { expect, test } from './fixtures'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'

const routeUrl = '/route?city=Taipei&route=307&routeUid=TPE19108&direction=0&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99&stopUid=TPE213044'
const routeUrlWithoutStopUid = '/route?city=Taipei&route=307&routeUid=TPE19108&direction=0&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99'

const routeIdentity = {
  schemaVersion: 1,
  stops: [
    { stopUid: 'TPE100', stopName: '板橋公車站', sequence: 1, selected: false },
    { stopUid: 'TPE213044', stopName: '捷運西門站', sequence: 2, selected: true },
  ],
}

const routeHtml = `<!doctype html><html><body>
<main class="route-page">
  <ol class="route-timeline">
    <li class="route-stop"><span class="dot"></span><div><strong>板橋公車站</strong></div><span class="route-eta muted">—</span></li>
    <li class="route-stop selected"><span class="dot"></span><div><strong>捷運西門站</strong><em>你的站牌</em></div><span class="route-eta muted">更新中</span></li>
  </ol>
</main>
<script id="route-identity" type="application/json">${JSON.stringify(routeIdentity)}</script>
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

function unavailableEta(warning: 'tdx-rate-limit' | 'tdx-quota' | 'tdx-unavailable', selectedLabel: string) {
  return {
    ...realtime,
    eta: { kind: 'unavailable', warning },
    stops: realtime.stops.map((stop, index) => ({
      ...stop,
      etaLabel: index === 1 ? selectedLabel : '—',
      etaTone: 'muted',
    })),
  }
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

  test('renders an exact timetable fallback as muted, explicitly scheduled text', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({
      json: {
        ...realtime,
        stops: realtime.stops.map((stop, index) => index === 0
          ? { ...stop, etaLabel: '表定 13:45', etaTone: 'muted' }
          : stop),
      },
    }))

    await page.goto(routeUrl)

    const scheduledEta = page.locator('.route-stop').nth(0).locator('.route-eta')
    await expect(scheduledEta).toHaveText('表定 13:45')
    await expect(scheduledEta).toHaveClass(/muted/)
    await expect(scheduledEta).not.toHaveClass(/live|urgent/)
  })

  test('keeps hydrating a legacy shared link without stopUid', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({ json: realtime }))

    await page.goto(routeUrlWithoutStopUid)

    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('12 分')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即將進站')
  })

  test('pauses while hidden and resumes only when the previous result is stale', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({
        json: {
          ...realtime,
          stops: realtime.stops.map((stop, index) => index === 1
            ? { ...stop, etaLabel: requests === 1 ? '2 分' : requests === 2 ? '1 分' : '即將進站' }
            : stop),
        },
      })
    })

    await page.goto(routeUrl)
    const selectedEta = page.locator('.route-stop.selected .route-eta')
    await expect.poll(() => requests).toBe(1)
    await expect(selectedEta).toHaveText('2 分')

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.clock.fastForward(60_000)
    expect(requests).toBe(1)

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await expect.poll(() => requests).toBe(2)
    await expect(selectedEta).toHaveText('1 分')

    // Exact interval boundaries are covered by refresh-controller unit tests. Keep
    // this browser test clear of request/DOM settlement microtask timing.
    await page.clock.fastForward(29_000)
    expect(requests).toBe(2)
    await page.clock.fastForward(1_000)
    await expect.poll(() => requests).toBe(3)
    await expect(selectedEta).toHaveText('即將進站')
  })

  test('backs off rate-limited ETA responses for two minutes', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({ json: requests === 1 ? unavailableEta('tdx-rate-limit', '即時忙線') : realtime })
    })

    await page.goto(routeUrl)
    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時忙線')

    await page.clock.fastForward(119_999)
    expect(requests).toBe(1)
    await page.clock.fastForward(1)
    await expect.poll(() => requests).toBe(2)
  })

  test('backs off exhausted quota responses for five minutes', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({ json: requests === 1 ? unavailableEta('tdx-quota', '額度不可用') : realtime })
    })

    await page.goto(routeUrl)
    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('額度不可用')

    await page.clock.fastForward(299_999)
    expect(requests).toBe(1)
    await page.clock.fastForward(1)
    await expect.poll(() => requests).toBe(2)
  })

  test('clears previously live ETA when a later browser request fails', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return requests === 1
        ? route.fulfill({ json: realtime })
        : route.fulfill({ status: 503, json: { error: '暫時無法讀取' } })
    })

    await page.goto(routeUrl)
    const firstEta = page.locator('.route-stop').nth(0).locator('.route-eta')
    const selectedEta = page.locator('.route-stop.selected .route-eta')
    await expect(firstEta).toHaveText('12 分')
    await expect(firstEta).toHaveClass(/live/)

    await page.clock.fastForward(30_000)
    await expect.poll(() => requests).toBe(2)
    await expect(firstEta).toHaveText('—')
    await expect(firstEta).toHaveClass(/muted/)
    await expect(firstEta).not.toHaveClass(/live/)
    await expect(selectedEta).toHaveText('即時未更新')

    await page.clock.fastForward(119_999)
    expect(requests).toBe(2)
    await page.clock.fastForward(1)
    await expect.poll(() => requests).toBe(3)
  })

  test('stops retrying a malformed ETA contract', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({ json: { ...realtime, schemaVersion: 2 } })
    })

    await page.goto(routeUrl)

    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
    await page.clock.fastForward(10 * 60_000)
    expect(requests).toBe(1)
  })

  test('keeps the station order and stops retrying a rejected personal token', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({
        status: 401,
        json: { code: TDX_ACCESS_TOKEN_REJECTED_CODE, error: 'TDX 授權已失效' },
      })
    })

    await page.goto(routeUrl)

    const selectedEta = page.locator('.route-stop.selected .route-eta')
    await expect(page.locator('.route-stop')).toHaveCount(2)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(selectedEta).toHaveText('憑證失效')
    await expect(selectedEta).toHaveClass(/muted/)
    await page.clock.fastForward(60_000)
    expect(requests).toBe(1)
  })

  test('rejects a same-name selected stop with the wrong physical identity without retrying', async ({ page }) => {
    let requests = 0
    await page.clock.install()
    await page.route('**/api/v1/route-eta*', (route) => {
      requests += 1
      return route.fulfill({
        json: {
          ...realtime,
          stops: realtime.stops.map((stop, index) => index === 1
            ? { ...stop, stopUid: 'TPE-WRONG' }
            : stop),
        },
      })
    })

    await page.goto(routeUrl)

    await expect.poll(() => requests).toBe(1)
    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
    await page.clock.fastForward(10 * 60_000)
    expect(requests).toBe(1)
  })

  test('rejects a non-selected row whose name matches but UID does not', async ({ page }) => {
    await page.route('**/api/v1/route-eta*', (route) => route.fulfill({
      json: {
        ...realtime,
        stops: realtime.stops.map((stop, index) => index === 0
          ? { ...stop, stopUid: 'TPE-OTHER-PLATFORM' }
          : stop),
      },
    }))

    await page.goto(routeUrl)

    await expect(page.locator('.route-stop').nth(0).locator('.route-eta')).toHaveText('—')
    await expect(page.locator('.route-stop.selected .route-eta')).toHaveText('即時未更新')
  })
})
