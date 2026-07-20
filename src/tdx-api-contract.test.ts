import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from './index'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from './domain/tdx-api-error'
import { resetTDXTestState } from './lib/tdx'

const etaUrl = new URL('https://bus.moc96336.com/api/v1/eta')
etaUrl.searchParams.set('city', 'Taipei')
etaUrl.searchParams.set('route', '307')
etaUrl.searchParams.set('routeUid', 'TPE19108')
etaUrl.searchParams.set('direction', '0')
etaUrl.searchParams.set('stop', '捷運西門站')
etaUrl.searchParams.set('stopUid', 'TPE213044')

const routeEtaUrl = new URL(etaUrl)
routeEtaUrl.pathname = '/api/v1/route-eta'

describe('TDX API degraded-data contract', () => {
  beforeEach(() => {
    resetTDXTestState()
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTDXTestState()
  })

  it('lets a rejected personal token reach the API boundary as a coded 401', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 401 })))

    const response = await app.request(etaUrl, {
      headers: { Authorization: 'Bearer expired-personal-token' },
    })

    expect(response.status).toBe(401)
    await expect(response.json()).resolves.toMatchObject({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
    })
  })

  it('uses the personal token for route ETA and keeps station order on rate limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const upstreamFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer personal-token')
      const url = String(input)
      if (url.includes('/StopOfRoute/')) {
        return Response.json([{
          RouteUID: 'TPE19108',
          RouteName: { Zh_tw: '307' },
          SubRouteUID: 'TPE19108-0',
          SubRouteName: { Zh_tw: '307' },
          Direction: 0,
          Stops: [
            { StopUID: 'TPE100', StopName: { Zh_tw: '板橋公車站' }, StopSequence: 1 },
            { StopUID: 'TPE213044', StopName: { Zh_tw: '捷運西門站' }, StopSequence: 2 },
          ],
        }])
      }
      if (url.includes('/EstimatedTimeOfArrival/')) {
        return new Response('rate limited', { status: 429 })
      }
      throw new Error(`unexpected upstream request: ${url}`)
    })
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await app.request(routeEtaUrl, {
      headers: { Authorization: 'Bearer personal-token' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      eta: { kind: 'unavailable', warning: 'tdx-rate-limit' },
      stops: [
        { stopUid: 'TPE100', stopName: '板橋公車站', etaLabel: '—', etaTone: 'muted' },
        { stopUid: 'TPE213044', stopName: '捷運西門站', etaLabel: '即時忙線', etaTone: 'muted' },
      ],
    })
    const requestedUrls = upstreamFetch.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/EstimatedTimeOfArrival/'))).toBe(true)
  })

  it('returns an actionable warning instead of caching an empty vehicle list on rate limit', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))

    const response = await app.request(
      'https://bus.moc96336.com/api/v1/map/vehicles?city=Taipei&route=307&routeUid=TPE19108&direction=0',
      { headers: { Authorization: 'Bearer personal-token' } },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      vehicles: [],
      warning: 'tdx-rate-limit',
    })
  })

  it('keeps a rejected personal token explicit on the vehicle endpoint', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 401 })))

    const response = await app.request(
      'https://bus.moc96336.com/api/v1/map/vehicles?city=Taipei&route=307',
      { headers: { Authorization: 'Bearer expired-personal-token' } },
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({ code: TDX_ACCESS_TOKEN_REJECTED_CODE })
  })
})
