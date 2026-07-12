import { Hono, type Context } from 'hono'
import { defaultBusQuery, supportedCities, supportedCityCodes } from '../config'
import {
  canonicalBusPath,
  parseBusQuery,
  QueryValidationError,
  toBusSearchParams,
  type BusQuery,
} from '../domain/bus-query'
import {
  getCommuteETA,
  getRouteCatalog,
  getRouteDetail,
  getRouteStopGroups,
  getStopRouteSuggestions,
  QueryResolutionError,
  resolveBusQuery,
  TDXServiceError,
  tdxWarningFromError,
  tdxWarningMessages,
  verifyTDXCredentials,
  withTDXBackgroundTasks,
  withUserTDX,
  type TDXEnv,
  type TDXWarning,
} from '../lib/tdx'
import { appIcon, renderAmbiguousPage, renderETAPage, renderRoutePage, renderSetupPage } from '../ui'
import { getSnapshotRouteCatalog, getSnapshotRouteVariants, type TransitBindings } from '../infrastructure/transit/snapshot-repository'
import { mapCities } from '../config/map-cities'
import { siteSearchDescription } from '../seo'
import {
  ApiInputError,
  apiInputErrorBody,
  optionalQueryString,
  parseTdxCredentials,
  requiredQueryString,
} from '../lib/api-input'

type Env = { Bindings: TDXEnv & TransitBindings }
const bus = new Hono<Env>()

// API 請求可帶使用者自備的 TDX 憑證(setup 頁進階設定),即時查詢改用他的額度。
const tdxEnv = (c: Context<Env>) => {
  const credentials = parseTdxCredentials(
    c.req.header('x-tdx-client-id'),
    c.req.header('x-tdx-client-secret'),
  )
  const env = withUserTDX(c.env, credentials?.clientId, credentials?.clientSecret)
  try {
    const executionCtx = c.executionCtx
    return withTDXBackgroundTasks(env, (promise) => executionCtx.waitUntil(promise))
  } catch {
    return env
  }
}

bus.get('/', async (c) => renderETA(c, defaultBusQuery, true, true, homeNotice(c)))

bus.get('/bus', async (c) => {
  if (!hasBusQuery(c)) return c.redirect('/')

  try {
    const query = parseRequestQuery(c)
    const resolved = await resolveBusQuery(tdxEnv(c), query)
    if (!query.stopUid
      || query.stopName !== resolved.stopName
      || query.routeUid !== resolved.routeUid
      || query.subRouteUid !== resolved.subRouteUid) {
      return c.redirect(canonicalBusPath(resolved), 302)
    }
    return renderETA(c, resolved, false, true)
  } catch (error) {
    if (error instanceof QueryResolutionError && error.candidates.length > 1) {
      const query = parseRequestQuery(c)
      return c.html(renderAmbiguousPage(query, error.candidates, c.req.url), 409, pageHeaders)
    }
    if (error instanceof TDXServiceError) {
      // TDX 掛掉(額度用完/頻率超限/連不上)時不丟錯誤頁:URL 帶齊識別碼就先信它、
      // 跳過站牌驗證照常渲染,已存書籤還能看時刻表 fallback;資訊不足的查詢才回首頁並帶提示。
      const query = parseRequestQuery(c)
      if (query.stopUid && query.stopName) return renderETA(c, query, false, true)
      return redirectHomeWithTDXNotice(c, error)
    }
    return renderPageError(c, error)
  }
})

bus.get('/setup', (c) => c.html(renderSetupPage(supportedCities, c.req.url), 200, pageHeaders))

bus.get('/route', async (c) => {
  let query: BusQuery
  try {
    query = parseRequestQuery(c)
  } catch (error) {
    return renderPageError(c, error)
  }
  try {
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, query)
    const detail = await getRouteDetail(env, resolved)
    return c.html(renderRoutePage(resolved, detail, c.req.url), 200, pageHeaders)
  } catch (error) {
    try {
      const fallback = await getSnapshotRoutePage(c.env, query)
      if (fallback) return c.html(renderRoutePage(fallback.resolved, fallback.detail, c.req.url), 200, pageHeaders)
    } catch (fallbackError) {
      console.error('route_snapshot_fallback_failed', fallbackError)
    }
    return renderPageError(c, error)
  }
})

async function getSnapshotRoutePage(env: TDXEnv & TransitBindings, query: BusQuery) {
  if (!query.stopUid) return null
  const variants = await getSnapshotRouteVariants(env, query.city, query.routeName)
  const matchingVariants = variants.filter((candidate) =>
    candidate.direction === query.direction
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid)
    && candidate.stops.features.some((stop) => stop.properties.stopUid === query.stopUid),
  )
  // 舊網址缺少支線身分時，只有唯一結果才能安全回退，禁止任意挑第一條。
  if (matchingVariants.length !== 1) return null
  const variant = matchingVariants[0]
  const selectedStop = variant.stops.features.find((stop) => stop.properties.stopUid === query.stopUid)!
  const resolved = {
    ...query,
    routeUid: query.routeUid ?? variant.routeUid,
    subRouteUid: query.subRouteUid ?? variant.subRouteUid,
    stopUid: selectedStop.properties.stopUid,
    stopName: selectedStop.properties.stopName,
  }
  const detail = {
    routeName: variant.routeName,
    direction: variant.direction,
    label: variant.label,
    stops: [...variant.stops.features]
      .sort((a, b) => a.properties.sequence - b.properties.sequence)
      .map((stop) => ({
        stopUid: stop.properties.stopUid,
        stopName: stop.properties.stopName,
        sequence: stop.properties.sequence,
        selected: stop.properties.stopUid === query.stopUid,
        etaLabel: null,
      })),
  }
  return { resolved, detail }
}

bus.get('/api/v1/eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const query = parseRequestQuery(c)
    const resolved = query.stopUid && query.stopName
      ? query as BusQuery & { stopUid: string; stopName: string }
      : await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    return c.json(result, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/stops', async (c) => {
  try {
    const city = c.req.query('city')?.trim() || defaultBusQuery.city
    const routeName = requiredQueryString(c.req.query('route'), '公車路線', 40)
    const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
    if (!supportedCityCodes.has(city)) throw new QueryValidationError(`不支援的縣市：${city}`)

    const groups = await getRouteStopGroups(tdxEnv(c), city, routeName, routeUid)
    return c.json({ schemaVersion: 2, city, routeName, routeUid: routeUid ?? null, groups }, 200, {
      'Cache-Control': 'public, max-age=300',
    })
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim() || defaultBusQuery.city
    if (!supportedCityCodes.has(city)) throw new QueryValidationError(`不支援的縣市：${city}`)
    // 快照目錄優先:除了省 TDX 額度,也只有它包含攤入本縣市的公路客運路線;
    // 沒建快照的縣市才退回 TDX 即時目錄(只有市區公車)。
    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    // TDX 原始目錄已在 edge 快取；API schema 不交給瀏覽器長快取，避免舊欄位卡住 UI。
    return c.json({ schemaVersion: 2, city, routes }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/stop-routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim() || defaultBusQuery.city
    const stopName = requiredQueryString(c.req.query('stop'), '站牌名稱', 80)
    const stopUid = optionalQueryString(c.req.query('stopUid'), 'StopUID', 100)
    if (!supportedCityCodes.has(city)) throw new QueryValidationError(`不支援的縣市：${city}`)
    const buses = await getStopRouteSuggestions(tdxEnv(c), city, stopName, stopUid)
    return c.json({ city, stopName, buses }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

// setup 頁「儲存並測試」:驗證使用者自備的 TDX 憑證換不換得到 token。
// 憑證只從 header 進來、用完即丟;絕不寫進任何儲存或 log。
bus.get('/api/v1/tdx/verify', async (c) => {
  let credentials
  try {
    credentials = parseTdxCredentials(
      c.req.header('x-tdx-client-id'),
      c.req.header('x-tdx-client-secret'),
      true,
    )!
  } catch (error) {
    return jsonError(c, error)
  }
  try {
    await verifyTDXCredentials(credentials.clientId, credentials.clientSecret)
    return c.json({ ok: true }, 200, noStoreHeaders)
  } catch {
    return c.json({ error: '這組憑證換不到 token，檢查一下是不是貼錯了' }, 401, noStoreHeaders)
  }
})

// 舊版 API 相容端點。
bus.get('/api/eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, defaultBusQuery)
    return c.json(await getCommuteETA(env, resolved), 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

const shortcutHandler = async (c: Context<Env>) => {
  try {
    const query = hasBusQuery(c) ? parseRequestQuery(c) : defaultBusQuery
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    const staleText = result.stale ? '\n⚠️ 資料可能延遲' : ''
    return c.text(`${result.routeName}｜${result.stopName}\n${result.label}${staleText}`, 200, noStoreHeaders)
  } catch (error) {
    console.error('shortcut_eta_failed', error)
    return c.text(toPublicError(error), error instanceof QueryValidationError ? 400 : 503)
  }
}

bus.get('/shortcut', shortcutHandler)
bus.get('/bus/text', shortcutHandler)
bus.get('/text', shortcutHandler)

bus.get('/robots.txt', (c) => c.text([
  'User-agent: *',
  // API 是無限的查詢參數空間,別讓爬蟲在裡面亂逛
  'Disallow: /api/',
  `Sitemap: ${new URL('/sitemap.xml', c.req.url)}`,
  '',
].join('\n'), 200, { 'Cache-Control': 'public, max-age=86400' }))

bus.get('/sitemap.xml', (c) => {
  const origin = new URL(c.req.url).origin
  // 只列有意義的固定進入點:首頁、地圖、setup 與 22 個縣市深連結;
  // 路線/站牌是 client-side render,爬蟲拿到空殼,列了也沒用。
  const urls = [
    '/',
    '/map',
    '/setup',
    ...mapCities.map((city) => `/map?city=${city.code}`),
  ]
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${
    urls.map((path) => `  <url><loc>${origin}${path.replaceAll('&', '&amp;')}</loc></url>`).join('\n')
  }\n</urlset>`
  return c.body(body, 200, {
    'Content-Type': 'application/xml; charset=utf-8',
    'Cache-Control': 'public, max-age=86400',
  })
})

bus.get('/manifest.webmanifest', (c) => c.json({
  name: 'Mochi Bus',
  short_name: '公車到站',
  description: siteSearchDescription,
  start_url: '/',
  display: 'standalone',
  background_color: '#f7f2e8',
  theme_color: '#f7f2e8',
  icons: [
    { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' },
    { src: '/apple-touch-icon.png', sizes: '180x180', type: 'image/png', purpose: 'any maskable' },
  ],
}, 200, {
  'Content-Type': 'application/manifest+json; charset=utf-8',
  'Cache-Control': 'public, max-age=86400',
}))

bus.get('/icon.svg', (c) => c.body(appIcon, 200, {
  'Content-Type': 'image/svg+xml; charset=utf-8',
  'Cache-Control': 'public, max-age=86400',
}))

bus.get('/sw.js', (c) => c.body(`
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(fetch(event.request).catch(() => new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;padding:32px;background:#f7f2e8;color:#29251f}</style><h1>目前沒有網路</h1><p>到站時間要連線才拿得到，等訊號回來再試一次。</p>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } }
  )));
});`, 200, {
  'Content-Type': 'text/javascript; charset=utf-8',
  'Cache-Control': 'no-cache',
  'Service-Worker-Allowed': '/',
}))

async function renderETA(
  c: Context<Env>,
  query: BusQuery,
  useLocalPreset: boolean,
  alreadyResolved = false,
  notice?: string,
) {
  const preResolved = query.stopUid && query.stopName
    ? query as BusQuery & { stopUid: string; stopName: string }
    : undefined
  try {
    const env = tdxEnv(c)
    const resolved = alreadyResolved && preResolved ? preResolved : await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    return c.html(renderETAPage({ query: resolved, result, notice, useLocalBoard: useLocalPreset, requestUrl: c.req.url }), 200, pageHeaders)
  } catch (error) {
    console.error('eta_page_failed', error)
    // 出錯也盡量渲染頁面本體(帶錯誤訊息),別讓 TDX 故障把整頁打成錯誤頁;
    // query 帶齊識別碼就直接用,不再打一次注定失敗的 resolveBusQuery。
    try {
      const resolved = preResolved ?? await resolveBusQuery(tdxEnv(c), query)
      return c.html(renderETAPage({ query: resolved, error: toPublicError(error), notice, useLocalBoard: useLocalPreset, requestUrl: c.req.url }), 200, pageHeaders)
    } catch {
      return renderPageError(c, error)
    }
  }
}

function parseRequestQuery(c: Context<Env>): BusQuery {
  const input = c.req.query()
  return parseBusQuery(
    { ...input, city: input.city || defaultBusQuery.city },
    undefined,
    supportedCityCodes,
  )
}

function hasBusQuery(c: Context<Env>): boolean {
  return Boolean(c.req.query('route') || c.req.query('routeName'))
}

// 導回首頁時用 ?notice= 帶原因(值就是 TDXWarning),首頁據此顯示服務橫幅。
// `in` 會沿原型鏈找,`?notice=constructor` 這類使用者輸入會被誤判成合法 key,
// 取出的是 Object/Function 之類的原型成員而非字串,後面 escapeHTML() 對它
// 呼叫 .replaceAll 會直接丟 TypeError;改用 Object.hasOwn() 只認自身屬性。
export function resolveTDXNotice(value: string | undefined): string | undefined {
  return value && Object.hasOwn(tdxWarningMessages, value) ? tdxWarningMessages[value as TDXWarning] : undefined
}

function homeNotice(c: Context<Env>): string | undefined {
  return resolveTDXNotice(c.req.query('notice'))
}

function redirectHomeWithTDXNotice(c: Context<Env>, error: TDXServiceError) {
  return c.redirect(`/?notice=${tdxWarningFromError(error) ?? 'tdx-unavailable'}`, 302)
}

function renderPageError(c: Context<Env>, error: unknown) {
  const message = toPublicError(error)
  const isQueryError = error instanceof QueryValidationError || error instanceof QueryResolutionError
  const status = error instanceof QueryValidationError
    ? 400
    : error instanceof QueryResolutionError ? 404
      : error instanceof TDXServiceError && error.rateLimited ? 429 : 503
  const setupUrl = `/setup?${toBusSearchParams({ ...defaultBusQuery, stopName: defaultBusQuery.stopName }).toString()}`
  const title = isQueryError ? '找不到這班公車' : '暫時無法取得公車資料'
  const actions = isQueryError
    ? `<p><a href="${escapeHTML(setupUrl)}">重新選擇路線與站牌</a></p>`
    : '<p><a href="/">回到首頁</a> · <a href="/map">打開地圖</a></p>'
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;max-width:520px;margin:80px auto;padding:24px;background:#f7f2e8;color:#29251f}a{color:#a44f39}</style><h1>${escapeHTML(title)}</h1><p>${escapeHTML(message)}</p>${actions}`, status)
}

function jsonError(c: Context<Env>, error: unknown) {
  if (error instanceof ApiInputError) {
    return c.json(apiInputErrorBody(error), error.status, noStoreHeaders)
  }
  if (!(error instanceof QueryValidationError || error instanceof QueryResolutionError)) {
    console.error('bus_api_failed', error)
  }
  const status = error instanceof QueryValidationError
    ? 400
    : error instanceof QueryResolutionError ? 404
      : error instanceof TDXServiceError && error.rateLimited ? 429 : 502
  return c.json({ error: toPublicError(error) }, status, noStoreHeaders)
}

function toPublicError(error: unknown): string {
  if (error instanceof QueryValidationError || error instanceof QueryResolutionError) return error.message
  if (error instanceof TDXServiceError) return tdxWarningMessages[tdxWarningFromError(error) ?? 'tdx-unavailable']
  return '暫時無法取得公車資料'
}

function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}

const noStoreHeaders = { 'Cache-Control': 'no-store' }
const pageHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
}

export default bus
