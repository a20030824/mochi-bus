from pathlib import Path

TDX = Path('src/lib/tdx.ts')
TEST = Path('src/lib/tdx-resolution.test.ts')


def replace_once(text: str, old: str, new: str, label: str) -> str:
    count = text.count(old)
    if count != 1:
        raise RuntimeError(f'{label}: expected exactly one match, found {count}')
    return text.replace(old, new, 1)


def insert_before(text: str, anchor: str, addition: str, label: str) -> str:
    index = text.find(anchor)
    if index < 0:
        raise RuntimeError(f'{label}: anchor not found')
    return text[:index] + addition + text[index:]


text = TDX.read_text()

text = replace_once(
    text,
    """const tokenCache = new Map<string, TokenCache>()
const tdxCircuits = new Map<string, CircuitState>()
""",
    """type TDXUpstreamOutcome =
  | {
      ok: true
      data: unknown
      status: number
      retryCount: number
      initialFailureClass?: TelemetryFailureClass
    }
  | {
      ok: false
      error: TDXServiceError
      retryCount: number
      initialFailureClass?: TelemetryFailureClass
    }

const tokenCache = new Map<string, TokenCache>()
const tdxCircuits = new Map<string, CircuitState>()
const tokenFlights = new Map<string, Promise<string>>()
const dataFlights = new Map<string, Promise<TDXUpstreamOutcome>>()
""",
    'singleflight maps',
)

text = replace_once(
    text,
    """export function resetTDXTestState(): void {
  sharedRateLimitedSince = null
  tokenCache.clear()
  tdxCircuits.clear()
}
""",
    """export function resetTDXTestState(): void {
  sharedRateLimitedSince = null
  tokenCache.clear()
  tdxCircuits.clear()
  tokenFlights.clear()
  dataFlights.clear()
}
""",
    'reset singleflight state',
)

text = replace_once(
    text,
    """const MAX_RETRY_AFTER_MS = 5 * 60 * 1000
""",
    """const MAX_RETRY_AFTER_MS = 5 * 60 * 1000
const DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const TDX_ERROR_MAX_RESPONSE_BYTES = 32 * 1024
const TDX_TOKEN_MAX_RESPONSE_BYTES = 16 * 1024
const MAX_TDX_SINGLEFLIGHT_ENTRIES = 128
""",
    'body limit constants',
)

text = replace_once(
    text,
    """  const body = await response.text().catch(() => '')
""",
    """  const body = await readTextResponse(response, TDX_ERROR_MAX_RESPONSE_BYTES, true).catch(() => '')
""",
    'bounded error body',
)

text = replace_once(
    text,
    """async function tokenFor(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  isShared: boolean,
): Promise<string> {
  assertTDXCircuitClosed(tokenCircuitKey(credentialKey))
  const cached = cachedToken(credentialKey)
  if (cached) return cached
  return fetchTDXToken(clientId, clientSecret, credentialKey, isShared)
}
""",
    """async function tokenFor(
  clientId: string,
  clientSecret: string,
  credentialKey: string,
  isShared: boolean,
): Promise<string> {
  const existing = tokenFlights.get(credentialKey)
  if (existing) return existing

  assertTDXCircuitClosed(tokenCircuitKey(credentialKey))
  const cached = cachedToken(credentialKey)
  if (cached) return cached
  return joinSingleflight(
    tokenFlights,
    credentialKey,
    () => fetchTDXToken(clientId, clientSecret, credentialKey, isShared),
  ).promise
}
""",
    'token singleflight',
)

text = replace_once(
    text,
    """  let data: { access_token?: string; expires_in?: number }
  try {
    data = await response.json() as { access_token?: string; expires_in?: number }
  } catch (error) {
    const serviceError = new TDXServiceError('TDX token response is invalid JSON', 502, {
      cause: error,
      failureKind: 'invalid_json',
    })
    recordTDXCircuitFailure(circuitKey, serviceError)
    throw serviceError
  }
""",
    """  let data: { access_token?: string; expires_in?: number }
  try {
    data = await readJsonResponse(response, TDX_TOKEN_MAX_RESPONSE_BYTES) as {
      access_token?: string
      expires_in?: number
    }
  } catch (error) {
    const serviceError = error instanceof TDXPayloadTooLargeError
      ? error
      : new TDXServiceError('TDX token response is invalid JSON', 502, {
          cause: error,
          failureKind: 'invalid_json',
        })
    recordTDXCircuitFailure(circuitKey, serviceError)
    throw serviceError
  }
""",
    'bounded token body',
)

text = replace_once(
    text,
    """  const maxResponseBytes = normalizedResponseByteLimit(options.maxResponseBytes)
""",
    """  const maxResponseBytes = responseByteLimit(options.maxResponseBytes)
""",
    'default JSON response cap',
)

start_marker = "  let tokenInfo: Awaited<ReturnType<typeof getTDXToken>>"
end_marker = "class TDXPayloadTooLargeError"
start = text.find(start_marker)
end = text.find(end_marker, start)
if start < 0 or end < 0:
    raise RuntimeError('resolve upstream section markers not found')

new_upstream_section = r'''  let tokenInfo: Awaited<ReturnType<typeof getTDXToken>>
  try {
    tokenInfo = await getTDXToken(env)
  } catch (error) {
    const serviceError = asTDXServiceError(error)
    return finishFailure(
      serviceError,
      serviceError.failureKind !== 'circuit_open' && serviceError.failureKind !== 'unknown',
    )
  }
  const { token, isShared, credentialKey } = tokenInfo
  const circuitKey = dataCircuitKey(credentialKey)
  const flightKey = dataFlightKey(credentialKey, url, maxResponseBytes, options.operation)
  const existingFlight = dataFlights.get(flightKey)
  if (!existingFlight) {
    try {
      assertTDXCircuitClosed(circuitKey)
    } catch (error) {
      return finishFailure(asTDXServiceError(error), false)
    }
  }

  const { promise: upstreamPromise, leader } = joinSingleflight(
    dataFlights,
    flightKey,
    () => fetchTDXUpstream(url, maxResponseBytes, options.operation, token, isShared, circuitKey),
  )
  const upstream = await upstreamPromise
  retryCount = upstream.retryCount
  initialFailureClass = upstream.initialFailureClass
  if (!upstream.ok) return finishFailure(upstream.error, true)

  if (!validPayload(upstream.data, options.validate)) {
    const serviceError = new TDXServiceError('TDX response has an invalid schema', 502, {
      failureKind: 'invalid_schema',
    })
    if (leader) recordTDXCircuitFailure(circuitKey, serviceError)
    return finishFailure(serviceError, true)
  }

  const data = upstream.data as T
  if (leader) recordTDXCircuitSuccess(circuitKey)
  const cachedAt = now()
  memoryCacheSet(memoryKey, { data, cachedAt }, ttlSeconds)
  const resolved = completeData(data, 'upstream', 0, upstream.status)
  if (leader) {
    await cachePutFailOpen(edgeCache, cacheKey, new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${ttlSeconds}`,
        'X-Mochi-Cached-At': String(cachedAt),
      },
    }), 'tdx', env.TDX_BACKGROUND_TASKS)
  }
  return resolved
}

function dataFlightKey(
  credentialKey: string,
  url: URL,
  maxResponseBytes: number,
  operation?: TelemetryTdxOperation,
): string {
  return `${credentialKey}\0${operation ?? 'default'}\0${maxResponseBytes}\0${url.toString()}`
}

function joinSingleflight<T>(
  flights: Map<string, Promise<T>>,
  key: string,
  create: () => Promise<T>,
): { promise: Promise<T>; leader: boolean } {
  const existing = flights.get(key)
  if (existing) return { promise: existing, leader: false }

  const promise = create()
  if (flights.size < MAX_TDX_SINGLEFLIGHT_ENTRIES) {
    flights.set(key, promise)
    void promise.finally(() => {
      if (flights.get(key) === promise) flights.delete(key)
    }).catch(() => undefined)
  }
  return { promise, leader: true }
}

async function fetchTDXUpstream(
  url: URL,
  maxResponseBytes: number,
  operation: TelemetryTdxOperation | undefined,
  token: string,
  isShared: boolean,
  circuitKey: string,
): Promise<TDXUpstreamOutcome> {
  let retryCount = 0
  let initialFailureClass: TelemetryFailureClass | undefined

  while (true) {
    let response: Response
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      const serviceError = new TDXServiceError('TDX request failed', undefined, {
        cause: error,
        failureKind: transportFailureClass(error),
      })
      if (shouldRetryResolution(serviceError, operation, retryCount)) {
        retryCount += 1
        initialFailureClass = serviceError.failureKind
        continue
      }
      recordTDXCircuitFailure(circuitKey, serviceError)
      return { ok: false, error: serviceError, retryCount, initialFailureClass }
    }

    if (!response.ok) {
      const error = await tdxResponseError('TDX request failed', response, isShared)
      if (shouldRetryResolution(error, operation, retryCount)) {
        retryCount += 1
        initialFailureClass = error.failureKind
        continue
      }
      recordTDXCircuitFailure(circuitKey, error, response.headers.get('Retry-After'))
      return { ok: false, error, retryCount, initialFailureClass }
    }
    if (isShared) sharedRateLimitedSince = null

    try {
      const data = await readJsonResponse(response, maxResponseBytes)
      return { ok: true, data, status: response.status, retryCount, initialFailureClass }
    } catch (error) {
      const serviceError = error instanceof TDXPayloadTooLargeError
        ? error
        : new TDXServiceError('TDX response is invalid JSON', 502, {
            cause: error,
            failureKind: 'invalid_json',
          })
      if (serviceError instanceof TDXPayloadTooLargeError) {
        recordTDXCircuitSuccess(circuitKey)
        console.error(JSON.stringify({
          message: 'tdx_response_too_large',
          maxBytes: serviceError.maxBytes,
          receivedBytes: serviceError.receivedBytes ?? null,
        }))
      } else {
        recordTDXCircuitFailure(circuitKey, serviceError)
      }
      return { ok: false, error: serviceError, retryCount, initialFailureClass }
    }
  }
}

'''
text = text[:start] + new_upstream_section + text[end:]

helper_start = text.find('function normalizedResponseByteLimit')
helper_end = text.find('function parsedContentLength', helper_start)
if helper_start < 0 or helper_end < 0:
    raise RuntimeError('response reader helper markers not found')

new_readers = r'''function normalizedResponseByteLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

function responseByteLimit(value: number | undefined): number {
  return normalizedResponseByteLimit(value) ?? DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES
}

async function readJsonResponse(
  response: Response,
  maxBytes = DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES,
): Promise<unknown> {
  return JSON.parse(await readTextResponse(response, maxBytes, false))
}

async function readTextResponse(
  response: Response,
  maxBytes: number,
  truncateOnLimit: boolean,
): Promise<string> {
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes))
  const declaredLength = parsedContentLength(response.headers.get('Content-Length'))
  if (!truncateOnLimit && declaredLength !== undefined && declaredLength > safeMaxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new TDXPayloadTooLargeError(safeMaxBytes, declaredLength)
  }
  if (!response.body) return ''

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const remainingBytes = safeMaxBytes - receivedBytes
      if (value.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          body += decoder.decode(value.subarray(0, remainingBytes), { stream: true })
        }
        receivedBytes += value.byteLength
        await reader.cancel().catch(() => undefined)
        if (!truncateOnLimit) {
          throw new TDXPayloadTooLargeError(safeMaxBytes, receivedBytes)
        }
        body += decoder.decode()
        return body
      }

      receivedBytes += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return body
  } finally {
    reader.releaseLock()
  }
}

'''
text = text[:helper_start] + new_readers + text[helper_end:]

TDX.write_text(text)


test = TEST.read_text()

singleflight_tests = r'''  it('coalesces concurrent identical data requests and clears the flight afterward', async () => {
    let releaseResponse: (response: Response) => void = () => undefined
    const pendingResponse = new Promise<Response>((resolve) => {
      releaseResponse = resolve
    })
    let upstreamRequests = 0
    const fetchMock = vi.fn(() => {
      upstreamRequests += 1
      return upstreamRequests === 1
        ? pendingResponse
        : Promise.resolve(new Response(JSON.stringify([{ id: 'shared' }])))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    })
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=singleflight-data')
    const eventSets = [[], [], []] as TelemetryEnvelope[][]

    const requests = eventSets.map((events) => fetchTDXJson(observedEnv(events), url, 0, options))
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    releaseResponse(new Response(JSON.stringify([{ id: 'shared' }])))

    await expect(Promise.all(requests)).resolves.toEqual([
      [{ id: 'shared' }],
      [{ id: 'shared' }],
      [{ id: 'shared' }],
    ])
    await expect(fetchTDXJson(observedEnv([]), url, 0, options)).resolves.toEqual([{ id: 'shared' }])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(eventSets.every((events) => events.length === 1 && events[0]?.resolution === 'upstream')).toBe(true)
  })

  it('coalesces concurrent shared-token requests without mixing data URLs', async () => {
    let releaseToken: (response: Response) => void = () => undefined
    const pendingToken = new Promise<Response>((resolve) => {
      releaseToken = resolve
    })
    let tokenRequests = 0
    let dataRequests = 0
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input).includes('/openid-connect/token')) {
        tokenRequests += 1
        return pendingToken
      }
      dataRequests += 1
      return Promise.resolve(new Response(JSON.stringify([{ id: String(input) }])))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    })

    const first = fetchTDXJson(
      observedEnv([], false),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=token-flight-a'),
      0,
      options,
    )
    const second = fetchTDXJson(
      observedEnv([], false),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=token-flight-b'),
      0,
      options,
    )

    await vi.waitFor(() => expect(tokenRequests).toBe(1))
    releaseToken(new Response(JSON.stringify({ access_token: 'shared-token', expires_in: 600 })))
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)

    expect(tokenRequests).toBe(1)
    expect(dataRequests).toBe(2)
  })

'''
test = insert_before(
    test,
    "  it('serves an edge hit without making an upstream request', async () => {\n",
    singleflight_tests,
    'singleflight tests',
)

body_limit_tests = r'''  it('applies a default byte cap when the caller omits one', async () => {
    let cancelCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1
      },
    }), {
      headers: { 'Content-Length': String(64 * 1024 * 1024) },
    })))
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn() },
    })

    await expect(fetchTDXJson(
      observedEnv([]),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=default-byte-cap'),
      30,
      options,
    )).rejects.toThrow('byte limit')

    expect(cancelCount).toBe(1)
  })

  it('truncates oversized error bodies while preserving warning classification', async () => {
    const encoder = new TextEncoder()
    const chunk = encoder.encode(`monthly quota exceeded ${'x'.repeat(40 * 1024)}`)
    let cancelCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelCount += 1
      },
    }), {
      status: 403,
      headers: { 'Content-Length': String(chunk.byteLength) },
    })))
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn() },
    })
    const events: TelemetryEnvelope[] = []

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=bounded-error'),
      30,
      options,
    )).rejects.toThrow()

    expect(cancelCount).toBe(1)
    expect(events[0]).toMatchObject({ failureClass: 'quota', upstreamStatusClass: '4xx' })
  })

  it('rejects an oversized successful token response before requesting data', async () => {
    let cancelCount = 0
    const fetchMock = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1
      },
    }), {
      headers: { 'Content-Length': String(64 * 1024) },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn() },
    })

    await expect(fetchTDXJson(
      observedEnv([], false),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=oversized-token'),
      30,
      options,
    )).rejects.toThrow('byte limit')

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(cancelCount).toBe(1)
  })

'''
test = insert_before(
    test,
    "  it('replays stale data when Content-Length exceeds the configured response limit', async () => {\n",
    body_limit_tests,
    'body limit tests',
)

test = test.replace(
    "it('keeps capped and uncapped memory-cache identities separate'",
    "it('keeps different byte-limit memory-cache identities separate'",
    1,
)

TEST.write_text(test)
