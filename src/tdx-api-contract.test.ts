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
})
