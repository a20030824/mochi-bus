import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TelemetryEnvelope } from '../observability/telemetry'
import { resetMemoryCacheForTests } from './memory-cache'
import { fetchTDXJson, isTDXRecordArray, resetTDXTestState, resolveTDXJson, type TDXEnv } from './tdx'

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-07-19T02:15:30.123Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

function observedEnv(events: TelemetryEnvelope[], byok = true): TDXEnv {
  return {
    TDX_CLIENT_ID: 'shared-id',
    TDX_CLIENT_SECRET: 'shared-secret',
    ...(byok ? { TDX_USER_ACCESS_TOKEN: 'private-access-token' } : {}),
    CF_VERSION_METADATA: metadata,
    TDX_TELEMETRY: {
      random: () => 0,
      emitter: (event) => events.push(event),
    },
  }
}

const options = {
  operation: 'vehicle_positions' as const,
  city: 'Taipei' as const,
  validate: isTDXRecordArray<{ id: string }>,
}

describe('TDX logical resolution instrumentation', () => {
  beforeEach(() => {
    resetTDXTestState()
    resetMemoryCacheForTests()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTDXTestState()
    resetMemoryCacheForTests()
  })

  it('emits one upstream completion and one later memory-hit completion', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn(async () => new Response(JSON.stringify([{ id: 'one' }]), {
      headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } })
    const env = observedEnv(events)
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/test?private=query')

    await expect(fetchTDXJson(env, url, 30, options)).resolves.toEqual([{ id: 'one' }])
    await expect(fetchTDXJson(env, url, 30, options)).resolves.toEqual([{ id: 'one' }])

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ resolution: 'upstream', result: 'success', credentialScope: 'byok' })
    expect(events[1]).toMatchObject({ resolution: 'memory', result: 'success', upstreamStatusClass: 'none' })
    expect(JSON.stringify(events)).not.toMatch(/private=query|private-access-token|shared-secret|Authorization|fingerprint|routeUid|placeId|stopUid|plate|latitude|longitude|stack|message/i)
  })

  it('serves an edge hit without making an upstream request', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => new Response(JSON.stringify([{ id: 'edge' }]), {
          headers: { 'X-Mochi-Cached-At': String(Date.now() - 90_000) },
        })),
        put: vi.fn(),
      },
    })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=edge'),
      30,
      options,
    )).resolves.toEqual([{ id: 'edge' }])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ resolution: 'edge', result: 'success', dataAgeBucket: '1_5m' })
  })

  it('reports an old-format edge entry without a cache timestamp as unknown age', async () => {
    const events: TelemetryEnvelope[] = []
    vi.stubGlobal('fetch', vi.fn())
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => new Response(JSON.stringify([{ id: 'legacy-edge' }]))),
        put: vi.fn(),
      },
    })

    await fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=legacy-edge'),
      30,
      options,
    )
    expect(events[0]).toMatchObject({ resolution: 'edge', dataAgeBucket: 'unknown' })
  })

  it('records timeout then retry success as one recovered completion', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: 'recovered' }])))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=retry'),
      30,
      options,
    )).resolves.toEqual([{ id: 'recovered' }])

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      result: 'success',
      resolution: 'upstream',
      retryCountBucket: '1',
      recoveredAfterRetry: true,
      initialFailureClass: 'timeout',
    })
  })

  it('does not retry 429 and records a single rate-limited error', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 429 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=rate-limit'),
      30,
      options,
    )).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      result: 'error',
      resolution: 'upstream',
      failureClass: 'rate_limited',
      retryCountBucket: '0',
    })
  })

  it('keeps quota exhaustion distinct from ordinary rate limiting', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn(async () => new Response('monthly quota exceeded', { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=quota'),
      30,
      options,
    )).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(events[0]).toMatchObject({
      result: 'error',
      failureClass: 'quota',
      upstreamStatusClass: '4xx',
    })
  })

  it('records exhausted retries as one final error with the initial failure class', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('first timeout', 'TimeoutError'))
      .mockResolvedValueOnce(new Response('still unavailable', { status: 503 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=retry-exhausted'),
      30,
      options,
    )).rejects.toThrow()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      result: 'error',
      resolution: 'upstream',
      failureClass: 'upstream_5xx',
      retryCountBucket: '1',
      recoveredAfterRetry: false,
      initialFailureClass: 'timeout',
    })
  })

  it('records an upstream failure followed by stale replay as one degraded completion', async () => {
    const events: TelemetryEnvelope[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })

    const resolved = await resolveTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=upstream-stale'),
      30,
      {
        ...options,
        staleFallback: async () => ({ data: [{ id: 'last-known' }], dataAgeMilliseconds: 7 * 60_000 }),
      },
    )

    expect(resolved).toMatchObject({ resolution: 'stale_replay', degraded: true })
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      resolution: 'stale_replay',
      result: 'degraded',
      failureClass: 'rate_limited',
      upstreamStatusClass: '4xx',
      dataAgeBucket: '5_30m',
    })
  })

  it('keeps legal empty, invalid JSON, and invalid schema distinct', async () => {
    const cases = [
      { body: '[]', expected: { result: 'empty', failureClass: 'none' } },
      { body: '{', expected: { result: 'error', failureClass: 'invalid_json' } },
      { body: '{}', expected: { result: 'error', failureClass: 'invalid_schema' } },
      { body: '[null]', expected: { result: 'error', failureClass: 'invalid_schema' } },
    ] as const
    for (const [index, testCase] of cases.entries()) {
      resetTDXTestState()
      resetMemoryCacheForTests()
      const events: TelemetryEnvelope[] = []
      vi.stubGlobal('fetch', vi.fn(async () => new Response(testCase.body)))
      vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } })
      const promise = fetchTDXJson(
        observedEnv(events),
        new URL(`https://tdx.transportdata.tw/api/basic/v2/test?case=payload-${index}`),
        30,
        options,
      )
      if (testCase.expected.result === 'empty') await expect(promise).resolves.toEqual([])
      else await expect(promise).rejects.toThrow()
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject(testCase.expected)
    }
  })

  it('replays stale data when Content-Length exceeds the configured response limit', async () => {
    const events: TelemetryEnvelope[] = []
    const cachePut = vi.fn()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'fresh' }]), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': '4096',
      },
    })))
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: cachePut },
    })

    const resolved = await resolveTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=declared-too-large'),
      30,
      {
        ...options,
        maxResponseBytes: 64,
        staleFallback: async () => ({ data: [{ id: 'last-known' }], dataAgeMilliseconds: 90_000 }),
      },
    )

    expect(resolved).toMatchObject({
      data: [{ id: 'last-known' }],
      resolution: 'stale_replay',
      degraded: true,
    })
    expect(cachePut).not.toHaveBeenCalled()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      result: 'degraded',
      resolution: 'stale_replay',
      failureClass: 'invalid_schema',
    })
  })

  it('cancels the body immediately when declared length exceeds the limit', async () => {
    let cancelCount = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1
      },
    }), {
      headers: { 'Content-Length': '4096' },
    })))
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn() },
    })

    await expect(fetchTDXJson(
      observedEnv([]),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=declared-cancel'),
      30,
      { ...options, maxResponseBytes: 64 },
    )).rejects.toThrow('byte limit')

    expect(cancelCount).toBe(1)
  })

  it('keeps capped and uncapped memory-cache identities separate', async () => {
    const payload = [{ id: 'x'.repeat(64) }]
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(payload)))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    })
    const url = new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=memory-limit')

    await expect(fetchTDXJson(observedEnv([]), url, 30, options)).resolves.toEqual(payload)
    await expect(fetchTDXJson(
      observedEnv([]),
      url,
      30,
      { ...options, maxResponseBytes: 32 },
    )).rejects.toThrow('byte limit')

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('cancels streamed oversized bodies without opening the TDX circuit', async () => {
    const events: TelemetryEnvelope[] = []
    const encoder = new TextEncoder()
    let requestCount = 0
    let cancelCount = 0
    const fetchMock = vi.fn(async () => {
      requestCount += 1
      if (requestCount === 4) {
        return new Response(JSON.stringify([{ id: 'healthy' }]))
      }
      let emitted = false
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (emitted) return
          emitted = true
          controller.enqueue(encoder.encode(JSON.stringify([{ id: 'x'.repeat(128) }])))
        },
        cancel() {
          cancelCount += 1
        },
      }))
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) },
    })

    for (let index = 0; index < 3; index += 1) {
      await expect(fetchTDXJson(
        observedEnv(events),
        new URL(`https://tdx.transportdata.tw/api/basic/v2/test?case=stream-too-large-${index}`),
        30,
        { ...options, maxResponseBytes: 32 },
      )).rejects.toThrow('byte limit')
    }

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=after-oversized'),
      30,
      { ...options, maxResponseBytes: 64 },
    )).resolves.toEqual([{ id: 'healthy' }])

    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(cancelCount).toBe(3)
  })

  it('records circuit-open stale replay as degraded and no-fallback as error', async () => {
    const initialEvents: TelemetryEnvelope[] = []
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })
    const env = observedEnv(initialEvents)
    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=open'),
      30,
      options,
    )).rejects.toThrow()

    const staleEvents: TelemetryEnvelope[] = []
    const staleEnv = observedEnv(staleEvents)
    const stale = await resolveTDXJson(
      staleEnv,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=stale'),
      30,
      {
        ...options,
        staleFallback: async () => ({ data: [{ id: 'stale' }], dataAgeMilliseconds: 90_000 }),
      },
    )
    expect(stale).toMatchObject({ data: [{ id: 'stale' }], resolution: 'stale_replay', degraded: true })
    expect(staleEvents).toHaveLength(1)
    expect(staleEvents[0]).toMatchObject({
      resolution: 'stale_replay',
      result: 'degraded',
      failureClass: 'circuit_open',
      dataAgeBucket: '1_5m',
      upstreamStatusClass: 'none',
    })

    const errorEvents: TelemetryEnvelope[] = []
    await expect(fetchTDXJson(
      observedEnv(errorEvents),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=blocked'),
      30,
      options,
    )).rejects.toThrow()
    expect(errorEvents).toHaveLength(1)
    expect(errorEvents[0]).toMatchObject({
      resolution: 'circuit_open',
      result: 'error',
      failureClass: 'circuit_open',
    })
  })

  it('allows a successful half-open probe and closes the circuit for later resolutions', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-19T03:00:00Z'))
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'Retry-After': '1' } }))
      .mockImplementation(async () => new Response(JSON.stringify([{ id: 'healthy' }])))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } })
    const env = observedEnv(events)

    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=open-short'),
      30,
      options,
    )).rejects.toThrow()
    vi.advanceTimersByTime(1_001)
    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=half-open'),
      30,
      options,
    )).resolves.toEqual([{ id: 'healthy' }])
    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=after-recovery'),
      30,
      options,
    )).resolves.toEqual([{ id: 'healthy' }])

    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events.at(-2)).toMatchObject({ result: 'success', resolution: 'upstream' })
    expect(events.at(-1)).toMatchObject({ result: 'success', resolution: 'upstream' })
  })

  it('classifies BYOK and shared token rejection by scope without retrying either', async () => {
    const byokEvents: TelemetryEnvelope[] = []
    const byokFetch = vi.fn(async () => new Response('rejected', { status: 401 }))
    vi.stubGlobal('fetch', byokFetch)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })
    await expect(fetchTDXJson(
      observedEnv(byokEvents),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=byok-401'),
      30,
      options,
    )).rejects.toThrow()
    expect(byokFetch).toHaveBeenCalledOnce()
    expect(byokEvents[0]).toMatchObject({ credentialScope: 'byok', failureClass: 'token_rejected' })

    resetTDXTestState()
    resetMemoryCacheForTests()
    const sharedEvents: TelemetryEnvelope[] = []
    const sharedFetch = vi.fn(async (input: string | URL | Request) => String(input).includes('/openid-connect/token')
      ? new Response(JSON.stringify({ access_token: 'shared-access-token', expires_in: 600 }))
      : new Response('rejected', { status: 401 }))
    vi.stubGlobal('fetch', sharedFetch)
    await expect(fetchTDXJson(
      observedEnv(sharedEvents, false),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=shared-401'),
      30,
      options,
    )).rejects.toThrow()
    expect(sharedFetch).toHaveBeenCalledTimes(2)
    expect(sharedEvents[0]).toMatchObject({ credentialScope: 'shared', failureClass: 'token_rejected' })
    expect(JSON.stringify([...byokEvents, ...sharedEvents])).not.toMatch(/private-access-token|shared-access-token|fingerprint/i)
  })

  it('does not label a local cooldown as an upstream response', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn() } })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=local-cooldown'),
      30,
      { ...options, blockedFailureClass: 'rate_limited' },
    )).rejects.toThrow()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({
      resolution: 'none',
      failureClass: 'rate_limited',
      upstreamStatusClass: 'none',
    })
  })

  it('still serves a valid cache hit while upstream access is locally cooling down', async () => {
    const events: TelemetryEnvelope[] = []
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => new Response(JSON.stringify([{ id: 'cached-during-cooldown' }]), {
          headers: { 'X-Mochi-Cached-At': String(Date.now()) },
        })),
        put: vi.fn(),
      },
    })

    await expect(fetchTDXJson(
      observedEnv(events),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=cached-cooldown'),
      30,
      { ...options, blockedFailureClass: 'rate_limited' },
    )).resolves.toEqual([{ id: 'cached-during-cooldown' }])

    expect(fetchMock).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ resolution: 'edge', result: 'success' })
  })

  it('keeps a successful resolution successful when cache or telemetry sinks fail', async () => {
    const env = observedEnv([])
    env.TDX_TELEMETRY = { random: () => 0, emitter: () => { throw new Error('sink failed') } }
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{ id: 'usable' }]))))
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => { throw new Error('cache read failed') }),
        put: vi.fn(async () => { throw new Error('cache write failed') }),
      },
    })

    await expect(fetchTDXJson(
      env,
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=fail-open'),
      30,
      options,
    )).resolves.toEqual([{ id: 'usable' }])
  })

  it('records shared scope without exposing its credential identity', async () => {
    const events: TelemetryEnvelope[] = []
    vi.stubGlobal('caches', { default: { match: vi.fn(async () => undefined), put: vi.fn(async () => undefined) } })
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      return url.includes('/openid-connect/token')
        ? new Response(JSON.stringify({ access_token: 'shared-token', expires_in: 600 }))
        : new Response(JSON.stringify([{ id: 'shared' }]))
    }))

    await fetchTDXJson(
      observedEnv(events, false),
      new URL('https://tdx.transportdata.tw/api/basic/v2/test?case=shared'),
      30,
      options,
    )
    expect(events[0]).toMatchObject({ credentialScope: 'shared', result: 'success' })
    expect(JSON.stringify(events[0])).not.toMatch(/shared-id|shared-secret|shared-token|fingerprint/i)
  })
})
