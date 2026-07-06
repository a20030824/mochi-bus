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
  verifyTDXCredentials,
  withUserTDX,
  type TDXEnv,
} from '../lib/tdx'
import { appIcon, renderAmbiguousPage, renderETAPage, renderRoutePage, renderSetupPage } from '../ui'
import { getSnapshotRouteVariants, type TransitBindings } from '../infrastructure/transit/snapshot-repository'
import { mapCities } from '../config/map-cities'

type Env = { Bindings: TDXEnv & TransitBindings }
const bus = new Hono<Env>()

// API 請求可帶使用者自備的 TDX 憑證(setup 頁進階設定),即時查詢改用他的額度。
const tdxEnv = (c: Context<Env>) =>
  withUserTDX(c.env, c.req.header('x-tdx-client-id'), c.req.header('x-tdx-client-secret'))

bus.get('/', async (c) => renderETA(c, defaultBusQuery, true))

bus.get('/bus', async (c) => {
  if (!hasBusQuery(c)) return c.redirect('/')

  try {
    const query = parseRequestQuery(c)
    const resolved = await resolveBusQuery(c.env, query)
    if (!query.stopUid || query.stopName !== resolved.stopName || query.routeUid !== resolved.routeUid) {
      return c.redirect(canonicalBusPath(resolved), 302)
    }
    return renderETA(c, resolved, false, true)
  } catch (error) {
    if (error instanceof QueryResolutionError && error.candidates.length > 1) {
      const query = parseRequestQuery(c)
      return c.html(renderAmbiguousPage(query, error.candidates), 409, pageHeaders)
    }
    return renderPageError(c, error)
  }
})

bus.get('/setup', (c) => c.html(renderSetupPage(supportedCities), 200, pageHeaders))

bus.get('/route', async (c) => {
  let query: BusQuery
  try {
    query = parseRequestQuery(c)
  } catch (error) {
    return renderPageError(c, error)
  }
  try {
    const resolved = await resolveBusQuery(c.env, query)
    const detail = await getRouteDetail(c.env, resolved)
    return c.html(renderRoutePage(resolved, detail), 200, pageHeaders)
  } catch (error) {
    try {
      const fallback = await getSnapshotRoutePage(c.env, query)
      if (fallback) return c.html(renderRoutePage(fallback.resolved, fallback.detail), 200, pageHeaders)
    } catch (fallbackError) {
      console.error('route_snapshot_fallback_failed', fallbackError)
    }
    return renderPageError(c, error)
  }
})

async function getSnapshotRoutePage(env: TDXEnv & TransitBindings, query: BusQuery) {
  if (!query.stopUid) return null
  const variants = await getSnapshotRouteVariants(env, query.city, query.routeName)
  const variant = variants.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.features.some((stop) => stop.properties.stopUid === query.stopUid),
  )
  if (!variant) return null
  const selectedStop = variant.stops.features.find((stop) => stop.properties.stopUid === query.stopUid)!
  const resolved = {
    ...query,
    routeUid: query.routeUid ?? variant.routeUid,
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
    const routeName = c.req.query('route')?.trim()
    if (!supportedCityCodes.has(city)) throw new QueryValidationError(`不支援的縣市：${city}`)
    if (!routeName) throw new QueryValidationError('請輸入公車路線')
    if (routeName.length > 40) throw new QueryValidationError('公車路線過長')

    const groups = await getRouteStopGroups(tdxEnv(c), city, routeName)
    return c.json({ city, routeName, groups }, 200, {
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
    const routes = await getRouteCatalog(tdxEnv(c), city)
    // TDX 原始目錄已在 edge 快取；API schema 不交給瀏覽器長快取，避免舊欄位卡住 UI。
    return c.json({ schemaVersion: 2, city, routes }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

bus.get('/api/v1/stop-routes', async (c) => {
  try {
    const city = c.req.query('city')?.trim() || defaultBusQuery.city
    const stopName = c.req.query('stop')?.trim()
    const stopUid = c.req.query('stopUid')?.trim()
    if (!supportedCityCodes.has(city)) throw new QueryValidationError(`不支援的縣市：${city}`)
    if (!stopName) throw new QueryValidationError('缺少站牌名稱')
    const buses = await getStopRouteSuggestions(tdxEnv(c), city, stopName, stopUid)
    return c.json({ city, stopName, buses }, 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

// setup 頁「儲存並測試」:驗證使用者自備的 TDX 憑證換不換得到 token。
// 憑證只從 header 進來、用完即丟;絕不寫進任何儲存或 log。
bus.get('/api/v1/tdx/verify', async (c) => {
  const clientId = c.req.header('x-tdx-client-id')?.trim()
  const clientSecret = c.req.header('x-tdx-client-secret')?.trim()
  if (!clientId || !clientSecret) {
    return c.json({ error: 'Client ID 與 Client Secret 都要填' }, 400, noStoreHeaders)
  }
  try {
    await verifyTDXCredentials(clientId, clientSecret)
    return c.json({ ok: true }, 200, noStoreHeaders)
  } catch {
    return c.json({ error: '這組憑證換不到 token，檢查一下是不是貼錯了' }, 401, noStoreHeaders)
  }
})

// 舊版 API 相容端點。
bus.get('/api/eta', async (c) => {
  try {
    const resolved = await resolveBusQuery(c.env, defaultBusQuery)
    return c.json(await getCommuteETA(c.env, resolved), 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

const shortcutHandler = async (c: Context<Env>) => {
  try {
    const query = hasBusQuery(c) ? parseRequestQuery(c) : defaultBusQuery
    const resolved = await resolveBusQuery(c.env, query)
    const result = await getCommuteETA(c.env, resolved)
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
  short_name: '公車 ETA',
  description: '一眼查看固定站牌的公車到站時間',
  start_url: '/',
  display: 'standalone',
  background_color: '#f7f2e8',
  theme_color: '#f7f2e8',
  icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
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
) {
  try {
    const resolved = alreadyResolved && query.stopUid && query.stopName
      ? query as BusQuery & { stopUid: string; stopName: string }
      : await resolveBusQuery(c.env, query)
    const result = await getCommuteETA(c.env, resolved)
    return c.html(renderETAPage({ query: resolved, result, useLocalBoard: useLocalPreset }), 200, pageHeaders)
  } catch (error) {
    console.error('eta_page_failed', error)
    try {
      const resolved = await resolveBusQuery(c.env, query)
      return c.html(renderETAPage({ query: resolved, error: toPublicError(error), useLocalBoard: useLocalPreset }), 200, pageHeaders)
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

function renderPageError(c: Context<Env>, error: unknown) {
  const message = toPublicError(error)
  const status = error instanceof QueryValidationError ? 400 : error instanceof QueryResolutionError ? 404 : 503
  const setupUrl = `/setup?${toBusSearchParams({ ...defaultBusQuery, stopName: defaultBusQuery.stopName }).toString()}`
  return c.html(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><style>body{font-family:system-ui;max-width:520px;margin:80px auto;padding:24px;background:#f7f2e8;color:#29251f}a{color:#a44f39}</style><h1>找不到這班公車</h1><p>${escapeHTML(message)}</p><p><a href="${escapeHTML(setupUrl)}">重新選擇路線與站牌</a></p>`, status)
}

function jsonError(c: Context<Env>, error: unknown) {
  console.error('bus_api_failed', error)
  const status = error instanceof QueryValidationError ? 400 : error instanceof QueryResolutionError ? 404 : 502
  return c.json({ error: toPublicError(error) }, status, noStoreHeaders)
}

function toPublicError(error: unknown): string {
  if (error instanceof QueryValidationError || error instanceof QueryResolutionError) return error.message
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
