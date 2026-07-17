import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'
import { resetTdxAuthMemoryForTests, setTdxAuth } from '../boards/store'
import { requestMochiJson } from './api-client'
import { resetTdxClientForTests, tdxHeaders } from './client'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

const rejectedTokenResponse = () => new Response(JSON.stringify({
  code: TDX_ACCESS_TOKEN_REJECTED_CODE,
  error: 'TDX 授權已失效',
}), { status: 401 })

describe('Mochi JSON API client', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    resetTdxAuthMemoryForTests()
    resetTdxClientForTests()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTdxAuthMemoryForTests()
    resetTdxClientForTests()
  })

  it('uses the fallback for HTML and empty responses instead of exposing JSON parse errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('<html>upstream failed</html>', { status: 502 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestMochiJson('/api/html', {}, { fallback: '暫時無法讀取' }))
      .rejects.toThrow('暫時無法讀取')
    await expect(requestMochiJson('/api/empty', {}, { fallback: '回應格式錯誤' }))
      .rejects.toThrow('回應格式錯誤')
  })

  it('refreshes a rejected personal token once and retries the Mochi request', async () => {
    setTdxAuth({ clientId: 'client-id', clientSecret: 'client-secret' })
    let tokenRequests = 0
    const apiAuthorizations: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/openid-connect/token')) {
        tokenRequests += 1
        return new Response(JSON.stringify({ access_token: tokenRequests === 1 ? 'old-token' : 'new-token', expires_in: 600 }))
      }
      const authorization = new Headers(init?.headers).get('Authorization') ?? ''
      apiAuthorizations.push(authorization)
      return authorization === 'Bearer old-token'
        ? rejectedTokenResponse()
        : new Response(JSON.stringify({ routes: ['ready'] }))
    }))

    await expect(requestMochiJson<{ routes: string[] }>('/api/routes', {}, { authenticated: true }))
      .resolves.toEqual({ routes: ['ready'] })
    expect(tokenRequests).toBe(2)
    expect(apiAuthorizations).toEqual(['Bearer old-token', 'Bearer new-token'])
  })

  it('stops after one refresh when the replacement token is also rejected', async () => {
    setTdxAuth({ clientId: 'client-id', clientSecret: 'client-secret' })
    let tokenRequests = 0
    let apiRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes('/openid-connect/token')) {
        tokenRequests += 1
        return new Response(JSON.stringify({ access_token: `token-${tokenRequests}`, expires_in: 600 }))
      }
      apiRequests += 1
      return rejectedTokenResponse()
    }))

    await expect(requestMochiJson('/api/routes', {}, { authenticated: true }))
      .rejects.toThrow('TDX 授權已失效')
    expect(tokenRequests).toBe(2)
    expect(apiRequests).toBe(2)
  })

  it('does not refresh a shared-credential request that has no personal authorization', async () => {
    const fetchMock = vi.fn(async () => rejectedTokenResponse())
    vi.stubGlobal('fetch', fetchMock)

    await expect(requestMochiJson('/api/routes', {}, { authenticated: true }))
      .rejects.toThrow('TDX 授權已失效')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('deduplicates concurrent refreshes without evicting the replacement token', async () => {
    setTdxAuth({ clientId: 'client-id', clientSecret: 'client-secret' })
    let tokenRequests = 0
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes('/openid-connect/token')) {
        tokenRequests += 1
        if (tokenRequests === 2) await Promise.resolve()
        return new Response(JSON.stringify({ access_token: tokenRequests === 1 ? 'old-token' : 'new-token', expires_in: 600 }))
      }
      const authorization = new Headers(init?.headers).get('Authorization')
      return authorization === 'Bearer old-token'
        ? rejectedTokenResponse()
        : new Response(JSON.stringify({ ready: true }))
    }))
    await tdxHeaders()

    const results = await Promise.all([
      requestMochiJson<{ ready: boolean }>('/api/one', {}, { authenticated: true }),
      requestMochiJson<{ ready: boolean }>('/api/two', {}, { authenticated: true }),
    ])

    expect(results).toEqual([{ ready: true }, { ready: true }])
    expect(tokenRequests).toBe(2)
  })
})
