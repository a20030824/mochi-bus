import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTdxAuthMemoryForTests, setTdxAuth } from '../boards/store'
import { resetTdxClientForTests, tdxHeaders, verifyTdxCredentials } from './client'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('TDX browser token client', () => {
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

  it('exchanges the secret with TDX directly and sends only the access token to Mochi APIs', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({
      access_token: 'short-lived-token',
      expires_in: 600,
    }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    setTdxAuth({ clientId: 'client-id', clientSecret: 'client-secret' })

    await expect(tdxHeaders()).resolves.toEqual({ Authorization: 'Bearer short-lived-token' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('tdx.transportdata.tw')
    expect(String(init?.body)).toContain('client_secret=client-secret')
    expect(JSON.stringify(await tdxHeaders())).not.toContain('client-secret')
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('isolates cached tokens for credentials with the same client id but different secrets', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body)
      const token = body.includes('secret-a') ? 'token-a' : 'token-b'
      return new Response(JSON.stringify({ access_token: token, expires_in: 600 }))
    })
    vi.stubGlobal('fetch', fetchMock)

    setTdxAuth({ clientId: 'same-id', clientSecret: 'secret-a' })
    await expect(tdxHeaders()).resolves.toEqual({ Authorization: 'Bearer token-a' })
    setTdxAuth({ clientId: 'same-id', clientSecret: 'secret-b' })
    await expect(tdxHeaders()).resolves.toEqual({ Authorization: 'Bearer token-b' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not expose upstream bodies or credentials in verification errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      'client-secret Authorization: Bearer leaked-token',
      { status: 401 },
    )))

    await expect(verifyTdxCredentials({ clientId: 'client-id', clientSecret: 'client-secret' }))
      .rejects.toThrow('TDX 憑證無效')
    try {
      await verifyTdxCredentials({ clientId: 'client-id', clientSecret: 'client-secret' })
    } catch (error) {
      expect(String(error)).not.toMatch(/client-secret|leaked-token|Authorization/)
    }
  })
})
