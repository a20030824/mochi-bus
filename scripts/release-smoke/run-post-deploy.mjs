import { writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'
import {
  networkPrefixMatches,
  readBoundedResponseText,
} from '../transit-snapshot/active-probe.mjs'
import {
  ReleaseSmokeError,
  discoverAssetGraph,
  runPostDeploySmoke,
  safeReleaseSmokeDiagnostic,
  validateArrivalsContract,
  validateReleaseIdentity,
  validateRoutesContract,
} from './post-deploy.mjs'

const DEFAULT_ORIGIN = 'https://bus.moc96336.com'
const REPORT_PATH = 'release-smoke-report.json'
const HTTP_TIMEOUT_MS = 20_000
const MAX_PAGE_BYTES = 1_048_576
const MAX_ASSET_BYTES = 4_194_304
const MAX_JSON_BYTES = 2_097_152
const NETWORK_PREFIX_BYTES = 65_536
const PAGES = Object.freeze([
  { path: '/', selector: '.eta-page' },
  { path: '/setup', selector: '.setup-page #board-list' },
  { path: '/map?city=Chiayi', selector: '#map-app', bootSelector: '.leaflet-container' },
])
const REPRESENTATIVE_CITIES = Object.freeze(['Taipei', 'Chiayi'])
const HASHED_ASSET = /^\/assets\/[^/?]+-[A-Za-z0-9_-]{6,}\.(?:js|css)$/

export async function main(env = process.env) {
  const expectedSha = env.EXPECTED_RELEASE_SHA
  try {
    const origin = productionOrigin(env.RELEASE_SMOKE_ORIGIN ?? DEFAULT_ORIGIN)
    const token = smokeToken(env, expectedSha)
    const report = await runPostDeploySmoke({
      expectedSha,
      readRelease: () => readRelease(origin, token),
      probeHttp: ({ phase, releaseSha }) => probeHttpSurface({ origin, token, phase, releaseSha }),
      probeBrowser: ({ releaseSha, workerVersionId }) => probeFreshBrowser({
        origin, token, releaseSha, workerVersionId,
      }),
      propagationTimeoutMs: duration(env.RELEASE_SMOKE_PROPAGATION_MS, 300_000),
      pollIntervalMs: duration(env.RELEASE_SMOKE_POLL_MS, 10_000, false),
      observationWindowMs: duration(env.RELEASE_SMOKE_OBSERVATION_MS, 600_000),
      observationIntervalMs: duration(env.RELEASE_SMOKE_OBSERVATION_POLL_MS, 60_000, false),
    })
    await writeReport(report)
    console.log(JSON.stringify({
      event: 'release_smoke_completed',
      result: 'success',
      releaseSha: report.releaseSha,
      workerVersionId: report.workerVersionId,
      observationChecks: report.observationChecks,
    }))
  } catch (error) {
    const diagnostic = safeReleaseSmokeDiagnostic(error, expectedSha)
    await writeReport({ schemaVersion: 1, ...diagnostic })
    console.error(JSON.stringify(diagnostic))
    process.exitCode = 1
  }
}

async function readRelease(origin, token) {
  return readJson(origin, addProbe('/api/v1/health/release', token, 'release'), 65_536, 'release_observation_failed')
}

async function probeHttpSurface({ origin, token, phase }) {
  const assetCache = new Map()
  const allAssets = new Set()
  for (const page of PAGES) {
    const response = await readText(origin, addProbe(page.path, token, phase), MAX_PAGE_BYTES, 'page_http_failed')
    if (!response.contentType.includes('text/html')
      || !/^<!doctype html>/i.test(response.body.trimStart())
      || !/<title>[^<]+<\/title>/i.test(response.body)) {
      throw new ReleaseSmokeError('page_contract_invalid')
    }
    const graph = await discoverAssetGraph({
      html: response.body,
      maxAssets: 64,
      readAsset: async (path) => {
        if (!assetCache.has(path)) {
          assetCache.set(path, await readStaticAsset(origin, path))
        }
        return assetCache.get(path)
      },
    })
    graph.forEach((path) => allAssets.add(path))
  }
  if (![...allAssets].some((path) => HASHED_ASSET.test(path))) {
    throw new ReleaseSmokeError('hashed_asset_missing')
  }

  const routesByCity = new Map()
  for (const city of REPRESENTATIVE_CITIES) {
    const routes = validateRoutesContract(await readJson(
      origin,
      addProbe(`/api/v1/map/routes?city=${encodeURIComponent(city)}`, token, `${phase}-${city}`),
      MAX_JSON_BYTES,
      'routes_contract_invalid',
    ), city)
    routesByCity.set(city, routes)
    const prefix = await readPrefix(
      origin,
      addProbe(`/api/v1/map/network?city=${encodeURIComponent(city)}`, token, `${phase}-${city}`),
      NETWORK_PREFIX_BYTES,
      'network_contract_invalid',
    )
    if (!networkPrefixMatches(prefix, city, routes.snapshotVersion)) {
      throw new ReleaseSmokeError('network_contract_invalid')
    }
  }

  const taipei = routesByCity.get('Taipei')
  const route = taipei.routes[0]
  const detail = await readJson(
    origin,
    addProbe(`/api/v1/map/route?city=Taipei&route=${encodeURIComponent(route.routeName)}&routeUid=${encodeURIComponent(route.routeUid)}`, token, `${phase}-route`),
    MAX_JSON_BYTES,
    'route_contract_invalid',
  )
  const variant = selectRouteVariant(detail, route.routeUid)
  const stopUid = variant.stops.features[0].properties.stopUid
  const place = await readJson(
    origin,
    addProbe(`/api/v1/map/stop-place?city=Taipei&stopUid=${encodeURIComponent(stopUid)}`, token, `${phase}-place`),
    MAX_JSON_BYTES,
    'degraded_contract_invalid',
  )
  if (!place?.place || typeof place.place.placeId !== 'string' || place.place.placeId.length === 0) {
    throw new ReleaseSmokeError('degraded_contract_invalid')
  }
  const arrivals = validateArrivalsContract(await readJson(
    origin,
    addProbe(`/api/v1/map/place/${encodeURIComponent(place.place.placeId)}/arrivals?city=Taipei`, token, `${phase}-arrivals`),
    MAX_JSON_BYTES,
    'degraded_contract_invalid',
  ), 'Taipei', taipei.snapshotVersion)

  return Object.freeze({
    phase,
    pages: PAGES.length,
    assets: allAssets.size,
    hashedAssets: [...allAssets].filter((path) => HASHED_ASSET.test(path)).length,
    cities: REPRESENTATIVE_CITIES.length,
    degradedObserved: arrivals.warning !== null,
  })
}

async function probeFreshBrowser({ origin, token, releaseSha, workerVersionId }) {
  let browser
  const totals = { pageErrors: 0, consoleErrors: 0, chunkFailures: 0 }
  try {
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      baseURL: origin,
      locale: 'zh-TW',
      serviceWorkers: 'block',
    })
    for (const target of PAGES) {
      const page = await context.newPage()
      page.on('pageerror', () => { totals.pageErrors += 1 })
      page.on('console', (message) => {
        if (message.type() === 'error') totals.consoleErrors += 1
      })
      page.on('requestfailed', (request) => {
        try {
          const url = new URL(request.url())
          if (url.origin === origin
            && /^\/assets\/.+\.(?:js|css)$/.test(url.pathname)) totals.chunkFailures += 1
        } catch {
          totals.chunkFailures += 1
        }
      })
      const response = await page.goto(addProbe(target.path, token, 'browser'), {
        waitUntil: 'domcontentloaded',
        timeout: 30_000,
      })
      if (!response || response.status() < 200 || response.status() >= 300) {
        throw new ReleaseSmokeError('browser_boot_failed')
      }
      await page.locator(target.selector).waitFor({ state: 'visible', timeout: 30_000 })
      if (target.bootSelector) {
        await page.locator(target.bootSelector).waitFor({ state: 'visible', timeout: 30_000 })
      }
      const observed = await page.evaluate(async () => {
        const response = await fetch('/api/v1/health/release', { cache: 'no-store' })
        if (!response.ok) return null
        return response.json()
      })
      const identity = validateReleaseIdentity(observed, releaseSha)
      if (identity.workerVersionId !== workerVersionId) {
        throw new ReleaseSmokeError('release_changed_during_observation')
      }
      const ready = await page.evaluate(() => ({
        readyState: document.readyState,
        title: document.title,
      }))
      if (!['interactive', 'complete'].includes(ready.readyState) || !ready.title) {
        throw new ReleaseSmokeError('browser_boot_failed')
      }
      await page.close()
    }
    await context.close()
  } catch (error) {
    if (error instanceof ReleaseSmokeError) throw error
    throw new ReleaseSmokeError('browser_boot_failed')
  } finally {
    await browser?.close().catch(() => undefined)
  }
  if (totals.pageErrors > 0) throw new ReleaseSmokeError('browser_page_error')
  if (totals.consoleErrors > 0) throw new ReleaseSmokeError('browser_console_error')
  if (totals.chunkFailures > 0) throw new ReleaseSmokeError('browser_chunk_load_failed')
  return Object.freeze({ pages: PAGES.length, ...totals })
}

function selectRouteVariant(value, routeUid) {
  const variant = Array.isArray(value?.variants)
    ? value.variants.find((candidate) => candidate?.routeUid === routeUid
      && Array.isArray(candidate?.stops?.features)
      && candidate.stops.features.length >= 2
      && candidate.stops.features.every((feature) => typeof feature?.properties?.stopUid === 'string'))
    : undefined
  if (value?.schemaVersion !== 1 || value?.city !== 'Taipei' || value?.source !== 'snapshot' || !variant) {
    throw new ReleaseSmokeError('route_contract_invalid')
  }
  return variant
}

async function readStaticAsset(origin, path) {
  const response = await readText(origin, path, MAX_ASSET_BYTES, 'asset_http_failed')
  const extension = path.split('.').at(-1)?.toLowerCase()
  if ((extension === 'js' && !response.contentType.includes('javascript'))
    || (extension === 'css' && !response.contentType.includes('text/css'))
    || response.contentType.includes('text/html')) {
    throw new ReleaseSmokeError('asset_contract_invalid')
  }
  return response
}

async function readJson(origin, path, maximumBytes, failureClass) {
  const response = await readText(origin, path, maximumBytes, failureClass)
  if (!response.contentType.includes('json')) throw new ReleaseSmokeError(failureClass)
  try {
    return JSON.parse(response.body)
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
}

async function readText(origin, path, maximumBytes, failureClass) {
  let response
  try {
    response = await fetch(new URL(path, origin), {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'mochi-bus-release-smoke/1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
  if (!response.ok) throw new ReleaseSmokeError(failureClass)
  try {
    return Object.freeze({
      contentType: response.headers.get('Content-Type')?.toLowerCase() ?? '',
      body: await readBoundedResponseText(response, maximumBytes),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
}

async function readPrefix(origin, path, maximumBytes, failureClass) {
  let response
  try {
    response = await fetch(new URL(path, origin), {
      headers: {
        'Cache-Control': 'no-cache',
        'User-Agent': 'mochi-bus-release-smoke/1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
  } catch {
    throw new ReleaseSmokeError(failureClass)
  }
  if (!response.ok || !response.body) throw new ReleaseSmokeError(failureClass)
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  try {
    while (bytes < maximumBytes) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maximumBytes - bytes
      const chunk = value.byteLength > remaining ? value.subarray(0, remaining) : value
      bytes += chunk.byteLength
      text += decoder.decode(chunk, { stream: bytes < maximumBytes })
      if (chunk.byteLength < value.byteLength) break
    }
  } catch {
    throw new ReleaseSmokeError(failureClass)
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (!text) throw new ReleaseSmokeError(failureClass)
  return text
}

function addProbe(path, token, phase) {
  const url = new URL(path, 'https://release-smoke.invalid')
  url.searchParams.set('release_smoke', `${token}:${phase}`)
  return `${url.pathname}${url.search}`
}

function productionOrigin(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  return url.origin
}

function smokeToken(env, expectedSha) {
  const run = String(env.GITHUB_RUN_ID ?? 'local').replace(/[^A-Za-z0-9._:-]/g, '').slice(0, 48)
  const sha = typeof expectedSha === 'string' ? expectedSha.slice(0, 12) : 'unknown'
  return `${run || 'local'}:${sha}`
}

function duration(value, fallback, allowZero = true) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isSafeInteger(number) || (allowZero ? number < 0 : number < 1)) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  return number
}

async function writeReport(report) {
  await writeFile(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
