import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  tdxCredentialScope as facadeTDXCredentialScope,
  withUserTDXAccessToken as facadeWithUserTDXAccessToken,
} from '../tdx'
import { TDXServiceError } from './error-classification'
import {
  createTDXTokenClient,
  tdxCredentialScope,
  withUserTDXAccessToken,
  type TDXTokenClientDependencies,
} from './token-client'

const tokenResponse = (token: string, expiresIn = 3600): Response => new Response(JSON.stringify({
  access_token: token,
  expires_in: expiresIn,
}), { headers: { 'Content-Type': 'application/json' } })

function createHarness(options: {
  now?: () => number
  maxTokenCacheEntries?: number
  fetcher?: ReturnType<typeof vi.fn>
} = {}) {
  const fetcher = options.fetcher ?? vi.fn(async () => tokenResponse('shared-token'))
  const assertCircuitClosed = vi.fn()
  const recordCircuitFailure = vi.fn()
  const recordCircuitSuccess = vi.fn()
  const responseError = vi.fn(async (_context: string, response: Response) => {
    const error = new TDXServiceError(`token failed (${response.status})`, response.status, {
      failureKind: response.status === 429 ? 'rate_limited' : 'upstream_4xx',
    })
    if (response.status === 429) error.warning = 'tdx-rate-limit'
    return error
  })
  const readJsonResponse = vi.fn(async (response: Response) => {
    const text = await response.text()
    return {
      data: JSON.parse(text),
      receivedBytes: new TextEncoder().encode(text).byteLength,
      declaredBytes: undefined,
    }
  })
  const logResponseTooLarge = vi.fn()
  const logResponseSize = vi.fn()

  const dependencies: TDXTokenClientDependencies = {
    requestTimeoutMs: 6000,
    assertCircuitClosed,
    recordCircuitFailure,
    recordCircuitSuccess,
    responseError,
    readJsonResponse,
    isPayloadTooLargeError: (error): error is TDXServiceError => (
      error instanceof TDXServiceError && error.message === 'too large'
    ),
    logResponseTooLarge,
    logResponseSize,
    fetcher: fetcher as typeof fetch,
    now: options.now,
    maxTokenCacheEntries: options.maxTokenCacheEntries,
  }

  return {
    client: createTDXTokenClient(dependencies),
    fetcher,
    assertCircuitClosed,
    recordCircuitFailure,
    recordCircuitSuccess,
    responseError,
    readJsonResponse,
    logResponseTooLarge,
    logResponseSize,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('TDX token client boundary', () => {
  it('keeps façade credential helpers bound to the extracted implementation', () => {
    expect(facadeTDXCredentialScope).toBe(tdxCredentialScope)
    expect(facadeWithUserTDXAccessToken).toBe(withUserTDXAccessToken)
  })

  it('keeps BYOK tokens out of fetch, circuit and credential keys', async () => {
    const harness = createHarness()
    const result = await harness.client.getTDXToken({
      TDX_CLIENT_ID: 'shared-id',
      TDX_CLIENT_SECRET: 'shared-secret',
      TDX_USER_ACCESS_TOKEN: 'personal-token',
    })

    expect(result).toMatchObject({ token: 'personal-token', isShared: false })
    expect(result.credentialKey).not.toContain('personal-token')
    expect(harness.fetcher).not.toHaveBeenCalled()
    expect(harness.assertCircuitClosed).not.toHaveBeenCalled()
    expect(await tdxCredentialScope({
      TDX_CLIENT_ID: 'id',
      TDX_CLIENT_SECRET: 'secret',
      TDX_USER_ACCESS_TOKEN: 'personal-token',
    })).toBe(`user/${result.credentialKey}`)
  })

  it('isolates shared credentials and preserves the form request plus six-second timeout', async () => {
    const timeoutSignal = new AbortController().signal
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeoutSignal)
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      return tokenResponse(`token-${body.get('client_secret')}`)
    })
    const harness = createHarness({ fetcher })

    const first = await harness.client.getTDXToken({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-a' })
    const second = await harness.client.getTDXToken({ TDX_CLIENT_ID: 'same-id', TDX_CLIENT_SECRET: 'secret-b' })

    expect(first.token).toBe('token-secret-a')
    expect(second.token).toBe('token-secret-b')
    expect(first.credentialKey).not.toBe(second.credentialKey)
    expect(first.credentialKey).not.toContain('secret-a')
    expect(timeoutSpy).toHaveBeenCalledWith(6000)
    const [, init] = fetcher.mock.calls[0]
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded')
  })

  it('deduplicates concurrent token requests after asynchronous fingerprinting', async () => {
    let resolveResponse!: (response: Response) => void
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve }))
    const harness = createHarness({ fetcher })
    const env = { TDX_CLIENT_ID: 'concurrent-id', TDX_CLIENT_SECRET: 'concurrent-secret' }

    const requests = Promise.all([
      harness.client.getTDXToken(env),
      harness.client.getTDXToken(env),
    ])
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1))
    resolveResponse(tokenResponse('one-token'))

    const [first, second] = await requests
    expect(first.token).toBe('one-token')
    expect(second).toEqual(first)
    expect(harness.recordCircuitSuccess).toHaveBeenCalledTimes(1)
  })

  it('maintains LRU recency and expires entries at the existing safety margin', async () => {
    let clock = 1_000_000
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams
      return tokenResponse(`token-${body.get('client_id')}`, 60)
    })
    const harness = createHarness({
      fetcher,
      now: () => clock,
      maxTokenCacheEntries: 2,
    })

    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'a', TDX_CLIENT_SECRET: 'secret' })
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'b', TDX_CLIENT_SECRET: 'secret' })
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'a', TDX_CLIENT_SECRET: 'secret' })
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'c', TDX_CLIENT_SECRET: 'secret' })
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'b', TDX_CLIENT_SECRET: 'secret' })
    expect(fetcher).toHaveBeenCalledTimes(4)

    clock += 29_999
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'c', TDX_CLIENT_SECRET: 'secret' })
    expect(fetcher).toHaveBeenCalledTimes(4)
    clock += 1
    await harness.client.getTDXToken({ TDX_CLIENT_ID: 'c', TDX_CLIENT_SECRET: 'secret' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })

  it('forwards HTTP failures and Retry-After to the existing token circuit', async () => {
    const fetcher = vi.fn(async () => new Response('limited', {
      status: 429,
      headers: { 'Retry-After': '10' },
    }))
    const harness = createHarness({ fetcher })

    await expect(harness.client.getTDXToken({
      TDX_CLIENT_ID: 'limited-id',
      TDX_CLIENT_SECRET: 'limited-secret',
    })).rejects.toMatchObject({ status: 429, warning: 'tdx-rate-limit' })

    expect(harness.responseError).toHaveBeenCalledWith(
      'TDX token request failed',
      expect.any(Response),
      true,
      { operation: 'token', resource: 'token' },
    )
    expect(harness.recordCircuitFailure).toHaveBeenCalledWith(
      expect.stringMatching(/^token\//),
      expect.any(TDXServiceError),
      '10',
    )
  })

  it('classifies transport, invalid JSON and missing-token failures without caching', async () => {
    const timeoutFetcher = vi.fn(async () => { throw new DOMException('timed out', 'TimeoutError') })
    const timeoutHarness = createHarness({ fetcher: timeoutFetcher })
    await expect(timeoutHarness.client.getTDXToken({
      TDX_CLIENT_ID: 'timeout-id',
      TDX_CLIENT_SECRET: 'timeout-secret',
    })).rejects.toMatchObject({ failureKind: 'timeout' })
    expect(timeoutHarness.recordCircuitFailure).toHaveBeenCalledTimes(1)

    const invalidHarness = createHarness({
      fetcher: vi.fn(async () => new Response('{invalid-json')),
    })
    await expect(invalidHarness.client.getTDXToken({
      TDX_CLIENT_ID: 'json-id',
      TDX_CLIENT_SECRET: 'json-secret',
    })).rejects.toMatchObject({ failureKind: 'invalid_json', status: 502 })

    const missingHarness = createHarness({
      fetcher: vi.fn(async () => new Response(JSON.stringify({ expires_in: 3600 }))),
    })
    await expect(missingHarness.client.getTDXToken({
      TDX_CLIENT_ID: 'missing-id',
      TDX_CLIENT_SECRET: 'missing-secret',
    })).rejects.toMatchObject({ failureKind: 'invalid_schema', status: 502 })
    expect(missingHarness.recordCircuitSuccess).not.toHaveBeenCalled()
  })

  it('preserves payload-too-large errors and clears token cache on reset', async () => {
    const harness = createHarness()
    harness.readJsonResponse.mockRejectedValueOnce(new TDXServiceError('too large', 502, {
      failureKind: 'invalid_schema',
    }))

    await expect(harness.client.getTDXToken({
      TDX_CLIENT_ID: 'large-id',
      TDX_CLIENT_SECRET: 'large-secret',
    })).rejects.toMatchObject({ message: 'too large' })
    expect(harness.logResponseTooLarge).toHaveBeenCalledTimes(1)

    const env = { TDX_CLIENT_ID: 'cached-id', TDX_CLIENT_SECRET: 'cached-secret' }
    await harness.client.getTDXToken(env)
    await harness.client.getTDXToken(env)
    expect(harness.fetcher).toHaveBeenCalledTimes(2)
    harness.client.resetTDXTokenState()
    await harness.client.getTDXToken(env)
    expect(harness.fetcher).toHaveBeenCalledTimes(3)
  })

  it('attaches a personal token without mutating shared credentials', () => {
    const env = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }
    const result = withUserTDXAccessToken(env, 'user-token')

    expect(result).toEqual({ ...env, TDX_USER_ACCESS_TOKEN: 'user-token' })
    expect(result).not.toBe(env)
    expect(withUserTDXAccessToken(env)).toBe(env)
    expect(withUserTDXAccessToken(env, null)).toBe(env)
  })
})
