import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TIMEOUT_MS } from './constants.mjs'
import { contentHash, readJson, sanitizePathFragment, sleep, stableStringify, writeJson } from './util.mjs'

const TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
const API_BASE = 'https://tdx.transportdata.tw/api/basic/v2/Bus'

export class TDXMeasurementError extends Error {
  constructor(message, details = {}, options = {}) {
    super(message, options)
    this.name = 'TDXMeasurementError'
    this.details = {
      endpointCategory: details.endpointCategory ?? 'unknown',
      city: details.city ?? null,
      httpStatus: Number.isInteger(details.httpStatus) ? details.httpStatus : null,
      failureClass: details.failureClass ?? 'unknown',
      retryCount: Number.isInteger(details.retryCount) ? details.retryCount : 0,
      timestamp: details.timestamp ?? new Date().toISOString(),
    }
  }
}

export async function loadCredentials({ env = process.env, varsFile = '.dev.vars' } = {}) {
  let fileVars = {}
  try { fileVars = parseVars(await readFile(varsFile, 'utf8')) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const clientId = env.TDX_CLIENT_ID ?? fileVars.TDX_CLIENT_ID
  const clientSecret = env.TDX_CLIENT_SECRET ?? fileVars.TDX_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new TDXMeasurementError('TDX credentials are required for live fetch', {
      endpointCategory: 'token', failureClass: 'missing_credentials',
    })
  }
  return { clientId, clientSecret }
}

export function parseVars(source) {
  const result = {}
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

export async function fetchRawBundle({
  cities,
  includeIntercity,
  rawDir,
  concurrency = 2,
  fetcher = fetch,
  now = () => new Date(),
  random = Math.random,
  progress = (entry) => console.log(stableStringify(entry)),
  credentials,
}) {
  const resolvedCredentials = credentials ?? await loadCredentials()
  const token = await fetchToken(resolvedCredentials, { fetcher, random, now })
  const requests = []
  for (const city of cities) {
    requests.push(endpointRequest('stop-of-route', city, `StopOfRoute/City/${city}`))
    requests.push(endpointRequest('shape', city, `Shape/City/${city}`))
  }
  if (includeIntercity) {
    requests.push(endpointRequest('stop-of-route-intercity', null, 'StopOfRoute/InterCity', 'intercity'))
    requests.push(endpointRequest('shape-intercity', null, 'Shape/InterCity', 'intercity'))
  }

  const fetchedAt = now().toISOString()
  const responses = await mapConcurrent(requests, concurrency, async (request) => {
    progress({ phase: 'fetch-start', endpointCategory: request.category, city: request.city, timestamp: now().toISOString() })
    const payload = await fetchJsonEndpoint(request, token, { fetcher, random, now })
    const hash = contentHash(payload)
    const fileName = `${sanitizePathFragment(request.scope)}-${sanitizePathFragment(request.city ?? 'all')}-${sanitizePathFragment(request.category)}.json`
    await writeJson(join(rawDir, fileName), payload)
    progress({ phase: 'fetch-complete', endpointCategory: request.category, city: request.city, timestamp: now().toISOString() })
    return { ...request, fileName, contentHash: hash, itemCount: Array.isArray(payload) ? payload.length : null, maxUpdateTime: payloadMaxUpdateTime(payload), payload }
  })

  const bundle = bundleFromResponses(responses, { cities, includeIntercity, fetchedAt })
  const manifest = {
    schemaVersion: 1,
    fetchedAt,
    cities: [...cities],
    includeIntercity,
    endpoints: responses.map(({ payload: _payload, path: _path, ...entry }) => entry),
    bundleContentHash: contentHash(bundle.sources),
  }
  await mkdir(rawDir, { recursive: true })
  await writeJson(join(rawDir, 'manifest.json'), manifest)
  return { bundle, manifest }
}

export async function replayRawBundle({ rawDir }) {
  const manifest = await readJson(join(rawDir, 'manifest.json'))
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest.endpoints)) {
    throw new TDXMeasurementError('Raw cache manifest is invalid', { failureClass: 'corrupt_cache' })
  }
  const responses = []
  for (const entry of manifest.endpoints) {
    const payload = await readJson(join(rawDir, entry.fileName))
    if (contentHash(payload) !== entry.contentHash) {
      throw new TDXMeasurementError('Raw cache content hash mismatch', {
        endpointCategory: entry.category, city: entry.city, failureClass: 'corrupt_cache',
      })
    }
    responses.push({ ...entry, payload })
  }
  const bundle = bundleFromResponses(responses, manifest)
  if (contentHash(bundle.sources) !== manifest.bundleContentHash) {
    throw new TDXMeasurementError('Raw cache bundle hash mismatch', { failureClass: 'corrupt_cache' })
  }
  return { bundle, manifest }
}

function bundleFromResponses(responses, metadata) {
  const sources = []
  for (const city of metadata.cities ?? []) {
    const stopOfRoute = responses.find((entry) => entry.scope === 'city' && entry.city === city && entry.category === 'stop-of-route')?.payload
    const shapes = responses.find((entry) => entry.scope === 'city' && entry.city === city && entry.category === 'shape')?.payload
    if (!Array.isArray(stopOfRoute) || !Array.isArray(shapes)) {
      throw new TDXMeasurementError('Raw cache is missing a city endpoint', { city, failureClass: 'corrupt_cache' })
    }
    sources.push({ scope: 'city', city, stopOfRoute, shapes })
  }
  if (metadata.includeIntercity) {
    const stopOfRoute = responses.find((entry) => entry.scope === 'intercity' && entry.category === 'stop-of-route-intercity')?.payload
    const shapes = responses.find((entry) => entry.scope === 'intercity' && entry.category === 'shape-intercity')?.payload
    if (!Array.isArray(stopOfRoute) || !Array.isArray(shapes)) {
      throw new TDXMeasurementError('Raw cache is missing an InterCity endpoint', { failureClass: 'corrupt_cache' })
    }
    sources.push({ scope: 'intercity', city: null, stopOfRoute, shapes })
  }
  return { schemaVersion: 1, fetchedAt: metadata.fetchedAt, sources }
}

async function fetchToken({ clientId, clientSecret }, dependencies) {
  const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
  const response = await requestWithRetry({
    endpointCategory: 'token', city: null, url: TOKEN_ENDPOINT,
    init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    ...dependencies,
  })
  let data
  try { data = await response.json() } catch {
    throw safeError('token', null, response.status, 'invalid_json', 0)
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw safeError('token', null, response.status, 'invalid_schema', 0)
  }
  return data.access_token
}

async function fetchJsonEndpoint(request, token, dependencies) {
  const response = await requestWithRetry({
    endpointCategory: request.category,
    city: request.city,
    url: `${API_BASE}/${request.path}?$format=JSON`,
    init: { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    ...dependencies,
  })
  try {
    const data = await response.json()
    if (!Array.isArray(data)) throw new Error('not-array')
    return data
  } catch {
    throw safeError(request.category, request.city, response.status, 'invalid_json', 0)
  }
}

async function requestWithRetry({ endpointCategory, city, url, init, fetcher, random, now, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    let response
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)
      try { response = await fetcher(url, { ...init, signal: controller.signal }) } finally { clearTimeout(timer) }
    } catch (error) {
      if (attempt === maxAttempts - 1) throw safeError(endpointCategory, city, null, classifyTransport(error), attempt)
      await sleep(backoffDelay(attempt, null, random, now))
      continue
    }
    if (response.ok) return response
    const retryable = response.status === 429 || response.status >= 500
    if (!retryable || attempt === maxAttempts - 1) {
      throw safeError(endpointCategory, city, response.status, classifyHttp(response.status), attempt)
    }
    await sleep(backoffDelay(attempt, response.headers.get('Retry-After'), random, now))
  }
  throw safeError(endpointCategory, city, null, 'retry_exhausted', maxAttempts - 1)
}

function backoffDelay(attempt, retryAfter, random, now) {
  const retryAfterMs = parseRetryAfter(retryAfter, now())
  if (retryAfterMs !== null) return Math.min(30_000, retryAfterMs)
  const base = Math.min(30_000, 2 ** (attempt + 1) * 1000)
  return Math.round(base * (0.75 + random() * 0.5))
}

export function parseRetryAfter(value, now = new Date()) {
  if (value === null || value === undefined || value === '') return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return Math.max(0, date.getTime() - now.getTime())
}

function payloadMaxUpdateTime(payload) {
  if (!Array.isArray(payload)) return null
  return payload.map((item) => typeof item?.UpdateTime === 'string' ? item.UpdateTime : null)
    .filter(Boolean).sort().at(-1) ?? null
}

function endpointRequest(category, city, path, scope = 'city') { return { category, city, path, scope } }
function classifyTransport(error) { return error?.name === 'AbortError' ? 'timeout' : 'transport' }
function classifyHttp(status) { return status === 429 ? 'rate_limited' : status >= 500 ? 'upstream_5xx' : 'upstream_4xx' }
function safeError(endpointCategory, city, httpStatus, failureClass, retryCount) {
  return new TDXMeasurementError('TDX measurement request failed', {
    endpointCategory, city, httpStatus, failureClass, retryCount,
  })
}

export function safeErrorRecord(error) {
  if (error instanceof TDXMeasurementError) return { ...error.details }
  if (error?.code === 'UNSUPPORTED_MATCHER_REVISION') {
    return { endpointCategory: 'matcher', city: null, httpStatus: null, failureClass: 'unsupported_matcher_revision', retryCount: 0, timestamp: new Date().toISOString() }
  }
  return { endpointCategory: 'unknown', city: null, httpStatus: null, failureClass: 'unexpected', retryCount: 0, timestamp: new Date().toISOString() }
}

export function assertRedacted(value, secrets) {
  const serialized = typeof value === 'string' ? value : stableStringify(value)
  const forbidden = ['Authorization', ...secrets.filter(Boolean)]
  for (const secret of forbidden) if (serialized.includes(secret)) throw new Error('Sensitive value leaked into measurement output')
}

async function mapConcurrent(items, concurrency, worker) {
  const results = new Array(items.length)
  let nextIndex = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}
