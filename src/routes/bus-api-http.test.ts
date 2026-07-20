import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../index'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import { resetTDXTestState, tdxWarningMessages } from '../lib/tdx'

const rejectedTokenStopsUrl = 'https://bus.moc96336.com/api/v1/stops?city=Taipei&route=401-contract'
const rateLimitedStopsUrl = 'https://bus.moc96336.com/api/v1/stops?city=Taipei&route=429-contract'
const unavailableStopsUrl = 'https://bus.moc96336.com/api/v1/stops?city=Taipei&route=502-contract'
const unresolvedEtaUrl = 'https://bus.moc96336.com/api/v1/eta?city=Taipei&route=307&direction=0&stop=%E6%8D%B7%E9%81%8B%E8%A5%BF%E9%96%80%E7%AB%99'
const bearerHeaders = { Authorization: 'Bearer contract-test-token' }

function busApiLogCalls(spy: ReturnType<typeof vi.spyOn>) {
  return spy.mock.calls.filter((call: unknown[]) => call[0] === 'bus_api_failed')
}

async function expectJsonContract(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('cache-control')).toBe('no-store')
  expect(response.headers.get('content-type')).toContain('application/json')
  return response.json()
}

describe('bus API HTTP error contract', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetTDXTestState()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
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

  it('returns a coded 400 without logging for invalid API input', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await app.request('https://bus.moc96336.com/api/v1/stops?city=Taipei')

    await expect(expectJsonContract(response, 400)).resolves.toEqual({
      error: '公車路線不可空白',
      code: 'INVALID_QUERY',
    })
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(busApiLogCalls(consoleError)).toHaveLength(0)
  })

  it('returns the coded 401 without boundary logging for a rejected personal token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 401 })))

    const response = await app.request(rejectedTokenStopsUrl, { headers: bearerHeaders })

    await expect(expectJsonContract(response, 401)).resolves.toEqual({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    })
    expect(busApiLogCalls(consoleError)).toHaveLength(0)
  })

  it('returns 404 without logging when Route resolution finds no matching stop', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))

    const response = await app.request(unresolvedEtaUrl, { headers: bearerHeaders })

    await expect(expectJsonContract(response, 404)).resolves.toEqual({
      error: '找不到 307 的 捷運西門站',
    })
    expect(busApiLogCalls(consoleError)).toHaveLength(0)
  })

  it('returns 429 and logs the service failure for a TDX rate limit', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))

    const response = await app.request(rateLimitedStopsUrl, { headers: bearerHeaders })

    await expect(expectJsonContract(response, 429)).resolves.toEqual({
      error: tdxWarningMessages['tdx-rate-limit'],
    })
    expect(busApiLogCalls(consoleError)).toHaveLength(1)
  })

  it('returns 502 and logs the service failure for an upstream outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))

    const response = await app.request(unavailableStopsUrl, { headers: bearerHeaders })

    await expect(expectJsonContract(response, 502)).resolves.toEqual({
      error: tdxWarningMessages['tdx-unavailable'],
    })
    expect(busApiLogCalls(consoleError)).toHaveLength(1)
  })
})
