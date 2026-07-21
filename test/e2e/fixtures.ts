import { expect, test as base, type Page } from '@playwright/test'

type UiFixtures = {
  pageErrors: Error[]
  workerApiFirewall: void
}

export const test = base.extend<UiFixtures>({
  pageErrors: [async ({ page }, use) => {
    const errors: Error[] = []
    page.on('pageerror', (error) => errors.push(error))
    await use(errors)
    expect(errors.map((error) => error.stack ?? error.message)).toEqual([])
  }, { auto: true }],
  workerApiFirewall: [async ({ page }, use) => {
    // Test-specific routes are registered later and therefore take precedence. Any API call a
    // UI-only spec did not explicitly mock is stopped here before it can mutate Worker singletons.
    await page.route(/\/api\/v1\//, (route) => route.abort('blockedbyclient'))
    await use()
  }, { auto: true }],
})

export { expect, type Page } from '@playwright/test'

// /map 的城市清單改由 SSR 內嵌(見 src/map-page.ts 的 #map-bootstrap),
// main.ts 只在內嵌清單缺席時才回退去打 /api/v1/map/cities。測試想控制
// client 看到的城市清單,就得改寫這段內嵌 JSON,單靠攔截網路 API 沒用了。
// cities: null 會把整段 bootstrap 拿掉,逼前端走網路回退路徑(用於驗證離線恢復)。
export async function mockMapBootstrapCities(page: Page, cities: unknown[] | null): Promise<void> {
  await page.route((url) => new URL(url).pathname === '/map', async (route) => {
    const response = await route.fetch()
    const html = await response.text()
    const patched = cities === null
      ? html.replace(/(<script id="map-bootstrap"[^>]*>)[\s\S]*?(<\/script>)/, '$1$2')
      : html.replace(
          /(<script id="map-bootstrap"[^>]*>)[\s\S]*?(<\/script>)/,
          `$1${JSON.stringify({ cities }).replace(/</g, '\\u003c')}$2`,
        )
    const headers = { ...response.headers() }
    delete headers['content-length']
    await route.fulfill({ response, body: patched, headers })
  })
}
