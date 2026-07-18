import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTdxAuthMemoryForTests, setTdxAuth } from '../boards/store'
import { resetTdxClientForTests } from '../tdx/client'
import { mapApi } from './map-api-client'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()
  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

describe('map API client', () => {
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

  it('adds only the short-lived token to authenticated Mochi API calls', async () => {
    setTdxAuth({ clientId: 'client-id', clientSecret: 'client-secret' })
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      requests.push({ url, init })
      if (url.includes('/openid-connect/token')) {
        return new Response(JSON.stringify({ access_token: 'access-token', expires_in: 600 }))
      }
      return new Response(JSON.stringify({ routes: [{ routeName: '307', category: '數字' }] }))
    }))

    await expect(mapApi.routes('Taipei')).resolves.toEqual([{ routeName: '307', category: '數字' }])

    const mochiRequest = requests.find((request) => request.url.startsWith('/api/'))
    const headers = new Headers(mochiRequest?.init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer access-token')
    expect(headers.has('x-tdx-client-id')).toBe(false)
    expect(headers.has('x-tdx-client-secret')).toBe(false)
    expect(JSON.stringify(mochiRequest)).not.toContain('client-secret')
  })

  it('preserves API error messages for the UI boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: '這個縣市目前沒有快照' }),
      { status: 503 },
    )))

    await expect(mapApi.network('Taipei')).rejects.toThrow('這個縣市目前沒有快照')
  })

  it('keeps snapshot-only requests free of authorization headers', async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).has('Authorization')).toBe(false)
      return new Response(JSON.stringify({ places: [] }))
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(mapApi.nearby('Taipei', 25, 121.5, 500)).resolves.toEqual([])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('preserves degraded arrival metadata instead of returning only route rows', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      routes: [{ routeName: '307' }],
      warning: 'tdx-rate-limit',
      realtime: { candidates: 1, queries: 0, rateLimited: true },
    }))))

    await expect(mapApi.placeRoutes('Taipei', 'P1')).resolves.toMatchObject({
      routes: [{ routeName: '307' }],
      warning: 'tdx-rate-limit',
      realtime: { rateLimited: true },
    })
  })

  it('drops apparently precise journey minutes when the source contract is missing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      estimates: [
        { key: 'unknown', minutes: 1 },
        { key: 'live', minutes: 8, source: 'realtime' },
      ],
      warning: 'tdx-rate-limit',
    }))))

    await expect(mapApi.journeyEta('Taipei', [
      { key: 'unknown', patternId: 'A:0', sequence: 1 },
      { key: 'live', patternId: 'B:0', sequence: 1 },
    ])).resolves.toEqual({
      estimates: [
        expect.objectContaining({ key: 'unknown', minutes: null, source: 'none' }),
        expect.objectContaining({ key: 'live', minutes: 8, source: 'realtime' }),
      ],
      warning: 'tdx-rate-limit',
    })
  })

  it('preserves vehicle degradation metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      vehicles: [],
      warning: 'tdx-unavailable',
    }))))

    await expect(mapApi.vehicles('Taipei', {
      routeName: '307', routeUid: 'TPE307', variantKey: '307:0', direction: 0,
      label: '起點 → 終點', subRouteName: '307', updatedAt: null,
      shape: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [] } },
      stops: { type: 'FeatureCollection', features: [] },
    })).resolves.toEqual({ vehicles: [], warning: 'tdx-unavailable' })
  })
})
