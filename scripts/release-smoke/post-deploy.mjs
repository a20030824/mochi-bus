const FULL_SHA = /^[0-9a-f]{40}$/
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/
const TDX_WARNINGS = new Set(['tdx-unavailable', 'tdx-rate-limit', 'tdx-quota'])
const ARRIVAL_SOURCES = new Set(['realtime', 'stale-realtime', 'schedule', 'none'])
const FAILURE_CLASSES = new Set([
  'release_not_observed',
  'release_identity_invalid',
  'release_propagation_timeout',
  'release_changed_during_observation',
  'release_observation_failed',
  'page_http_failed',
  'page_contract_invalid',
  'page_assets_missing',
  'asset_http_failed',
  'asset_contract_invalid',
  'asset_graph_limit',
  'hashed_asset_missing',
  'routes_contract_invalid',
  'route_contract_invalid',
  'network_contract_invalid',
  'degraded_contract_invalid',
  'browser_boot_failed',
  'browser_page_error',
  'browser_console_error',
  'browser_chunk_load_failed',
  'unknown',
])

export class ReleaseSmokeError extends Error {
  constructor(code) {
    super('Post-deploy release smoke failed')
    this.name = 'ReleaseSmokeError'
    this.code = FAILURE_CLASSES.has(code) ? code : 'unknown'
  }
}

export function validateReleaseIdentity(value, expectedSha) {
  if (!FULL_SHA.test(String(expectedSha ?? ''))) throw new ReleaseSmokeError('release_identity_invalid')
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  if (typeof value.releaseSha === 'string' && FULL_SHA.test(value.releaseSha) && value.releaseSha !== expectedSha) {
    throw new ReleaseSmokeError('release_not_observed')
  }
  if (value.releaseSha !== expectedSha
    || typeof value.workerVersionId !== 'string' || !SAFE_IDENTIFIER.test(value.workerVersionId)
    || typeof value.workerCreatedAt !== 'string' || !ISO_TIMESTAMP.test(value.workerCreatedAt)
    || !Number.isFinite(Date.parse(value.workerCreatedAt))) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }
  return Object.freeze({
    schemaVersion: 1,
    releaseSha: value.releaseSha,
    workerVersionId: value.workerVersionId,
    workerCreatedAt: new Date(Date.parse(value.workerCreatedAt)).toISOString(),
  })
}

export async function discoverAssetGraph({ html, readAsset, maxAssets = 48 }) {
  if (typeof html !== 'string' || typeof readAsset !== 'function') {
    throw new ReleaseSmokeError('page_contract_invalid')
  }
  const queue = extractHtmlAssets(html)
  if (queue.length === 0) throw new ReleaseSmokeError('page_assets_missing')
  const seen = new Set()
  const result = []

  while (queue.length > 0) {
    const path = queue.shift()
    if (seen.has(path)) continue
    if (seen.size >= maxAssets) throw new ReleaseSmokeError('asset_graph_limit')
    seen.add(path)
    result.push(path)

    let asset
    try {
      asset = await readAsset(path)
    } catch {
      throw new ReleaseSmokeError('asset_http_failed')
    }
    if (!asset || typeof asset !== 'object' || typeof asset.contentType !== 'string') {
      throw new ReleaseSmokeError('asset_contract_invalid')
    }
    const body = typeof asset.body === 'string' ? asset.body : ''
    const dependencies = asset.contentType.includes('javascript')
      ? extractJavaScriptAssets(body, path)
      : asset.contentType.includes('css')
        ? extractCssAssets(body, path)
        : []
    for (const dependency of dependencies) {
      if (!seen.has(dependency) && !queue.includes(dependency)) queue.push(dependency)
    }
  }

  return Object.freeze(result)
}

export function validateRoutesContract(value, city) {
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 2
    || value.city !== city
    || value.source !== 'snapshot'
    || typeof value.snapshotVersion !== 'string'
    || !SAFE_IDENTIFIER.test(value.snapshotVersion)
    || !Array.isArray(value.routes)
    || value.routes.length === 0
    || value.routes.some((route) => !route
      || typeof route.routeName !== 'string' || route.routeName.length === 0
      || typeof route.routeUid !== 'string' || route.routeUid.length === 0)) {
    throw new ReleaseSmokeError('routes_contract_invalid')
  }
  return Object.freeze({
    city,
    snapshotVersion: value.snapshotVersion,
    routes: value.routes,
  })
}

export function validateArrivalsContract(value, city, snapshotVersion) {
  const warning = value?.warning ?? null
  const routes = value?.routes
  if (!value || typeof value !== 'object'
    || value.schemaVersion !== 1
    || value.city !== city
    || value.scheduleSource !== 'place-bundle'
    || value.snapshotVersion !== snapshotVersion
    || !(warning === null || TDX_WARNINGS.has(warning))
    || !Array.isArray(routes)
    || routes.length === 0
    || routes.some((route) => !route
      || typeof route.routeName !== 'string' || route.routeName.length === 0
      || typeof route.routeUid !== 'string' || route.routeUid.length === 0
      || !ARRIVAL_SOURCES.has(route.source)
      || !(route.estimateSeconds === null
        || (typeof route.estimateSeconds === 'number' && Number.isFinite(route.estimateSeconds) && route.estimateSeconds >= 0)))
    || !value.realtime || typeof value.realtime !== 'object'
    || !Number.isInteger(value.realtime.candidates) || value.realtime.candidates < 0
    || !Number.isInteger(value.realtime.queries) || value.realtime.queries < 0
    || typeof value.realtime.rateLimited !== 'boolean') {
    throw new ReleaseSmokeError('degraded_contract_invalid')
  }
  return Object.freeze({
    city,
    snapshotVersion,
    warning,
    routeCount: routes.length,
    rateLimited: value.realtime.rateLimited,
  })
}

export async function runPostDeploySmoke({
  expectedSha,
  readRelease,
  probeHttp,
  probeBrowser,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  propagationTimeoutMs = 300_000,
  pollIntervalMs = 10_000,
  observationWindowMs = 600_000,
  observationIntervalMs = 60_000,
}) {
  if (!FULL_SHA.test(String(expectedSha ?? ''))
    || typeof readRelease !== 'function'
    || typeof probeHttp !== 'function'
    || typeof probeBrowser !== 'function'
    || !validDuration(propagationTimeoutMs)
    || !validDuration(pollIntervalMs, false)
    || !validDuration(observationWindowMs)
    || !validDuration(observationIntervalMs, false)) {
    throw new ReleaseSmokeError('release_identity_invalid')
  }

  const startedAt = now()
  const identity = await waitForRelease({
    expectedSha, readRelease, now, sleep, propagationTimeoutMs, pollIntervalMs,
  })
  const probeContext = Object.freeze({
    releaseSha: identity.releaseSha,
    workerVersionId: identity.workerVersionId,
  })
  const initialHttp = await probeHttp({ phase: 'initial', ...probeContext })
  const browser = await probeBrowser(probeContext)

  let observationChecks = 0
  if (observationWindowMs > 0) {
    const observationDeadline = now() + observationWindowMs
    while (now() < observationDeadline) {
      await sleep(Math.min(observationIntervalMs, observationDeadline - now()))
      let observed
      try {
        observed = validateReleaseIdentity(await readRelease(), expectedSha)
      } catch (error) {
        if (error instanceof ReleaseSmokeError && error.code === 'release_not_observed') {
          throw new ReleaseSmokeError('release_changed_during_observation')
        }
        if (error instanceof ReleaseSmokeError) throw error
        throw new ReleaseSmokeError('release_observation_failed')
      }
      if (observed.workerVersionId !== identity.workerVersionId) {
        throw new ReleaseSmokeError('release_changed_during_observation')
      }
      observationChecks += 1
    }
  }

  const finalHttp = await probeHttp({ phase: 'final', ...probeContext })
  return Object.freeze({
    schemaVersion: 1,
    result: 'success',
    releaseSha: identity.releaseSha,
    workerVersionId: identity.workerVersionId,
    workerCreatedAt: identity.workerCreatedAt,
    startedAt: new Date(startedAt).toISOString(),
    completedAt: new Date(now()).toISOString(),
    initialHttp,
    browser,
    observationChecks,
    finalHttp,
  })
}

export function safeReleaseSmokeDiagnostic(error, expectedSha) {
  const code = error instanceof ReleaseSmokeError || FAILURE_CLASSES.has(error?.code)
    ? error.code
    : 'unknown'
  return Object.freeze({
    event: 'release_smoke_completed',
    result: 'error',
    releaseSha: FULL_SHA.test(String(expectedSha ?? '')) ? expectedSha : null,
    failureClass: FAILURE_CLASSES.has(code) ? code : 'unknown',
  })
}

async function waitForRelease({ expectedSha, readRelease, now, sleep, propagationTimeoutMs, pollIntervalMs }) {
  const deadline = now() + propagationTimeoutMs
  while (true) {
    try {
      return validateReleaseIdentity(await readRelease(), expectedSha)
    } catch (error) {
      const retryable = error instanceof ReleaseSmokeError
        && (error.code === 'release_not_observed' || error.code === 'release_observation_failed')
      if (!retryable) throw error
    }
    if (now() >= deadline) throw new ReleaseSmokeError('release_propagation_timeout')
    await sleep(Math.min(pollIntervalMs, deadline - now()))
  }
}

function extractHtmlAssets(html) {
  const assets = []
  const pattern = /\b(?:src|href)\s*=\s*["']([^"']+)["']/gi
  for (const match of html.matchAll(pattern)) {
    const path = resolveSameOriginAsset(match[1], '/')
    if (path && isStaticAssetPath(path) && !assets.includes(path)) assets.push(path)
  }
  return assets
}

function extractJavaScriptAssets(source, parentPath) {
  const assets = []
  const patterns = [
    /\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const path = resolveSameOriginAsset(match[1], parentPath)
      if (path && isStaticAssetPath(path) && !assets.includes(path)) assets.push(path)
    }
  }
  return assets
}

function extractCssAssets(source, parentPath) {
  const assets = []
  const patterns = [
    /@import\s+(?:url\()?\s*["']([^"']+)["']\s*\)?/g,
    /url\(\s*["']?([^"')]+)["']?\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const path = resolveSameOriginAsset(match[1], parentPath)
      if (path && isStaticAssetPath(path) && !assets.includes(path)) assets.push(path)
    }
  }
  return assets
}

function resolveSameOriginAsset(reference, parentPath) {
  if (typeof reference !== 'string'
    || reference.startsWith('data:')
    || reference.startsWith('blob:')
    || reference.startsWith('//')
    || /^[a-z][a-z0-9+.-]*:/i.test(reference)) return null
  try {
    const url = new URL(reference, `https://release-smoke.invalid${parentPath}`)
    return url.pathname
  } catch {
    return null
  }
}

function isStaticAssetPath(path) {
  return /^\/(?:assets\/|[^/?]+\.(?:js|css|svg|png|webp|ico|woff2?|webmanifest|json)$)/i.test(path)
}

function validDuration(value, allowZero = true) {
  return Number.isSafeInteger(value) && (allowZero ? value >= 0 : value > 0)
}
