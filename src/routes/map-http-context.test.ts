import { Hono, type Context } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import { QueryValidationError } from '../domain/bus-query'
import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../domain/tdx-api-error'
import { ApiInputError } from '../lib/api-input'
import { TDXServiceError } from '../lib/tdx'
import type { ApiOperationTracker } from '../observability/api-operation'
import {
  completeMapError,
  mapJsonError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
} as MapEnv['Bindings']

function requestWith(
  handler: (c: Context<MapEnv>) => Response,
  authorization?: string,
): Promise<Response> {
  const app = new Hono<MapEnv>()
  app.get('/', handler)
  return Promise.resolve(app.request('https://bus.example/', {
    headers: authorization ? { Authorization: authorization } : undefined,
  }, bindings))
}

describe('Map HTTP context', () => {
  it('builds request-local TDX access from a personal bearer token', async () => {
    const response = await requestWith((c) => {
      const env = tdxEnv(c)
      return c.json({ userToken: env.TDX_USER_ACCESS_TOKEN ?? null })
    }, 'Bearer personal-token')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ userToken: 'personal-token' })
    expect(bindings).not.toHaveProperty('TDX_USER_ACCESS_TOKEN')
  })

  it('keeps supported telemetry cities and drops unknown values', () => {
    expect(telemetryCity('Taipei')).toBe('Taipei')
    expect(telemetryCity('Unknown')).toBeNull()
    expect(telemetryCity(undefined)).toBeNull()
  })

  it('preserves coded input errors and query validation responses', async () => {
    const input = await requestWith((c) => mapJsonError(
      c,
      new ApiInputError(422, 'INVALID_REQUEST', '內容格式錯誤'),
      'fallback',
    ))
    expect(input.status).toBe(422)
    expect(input.headers.get('Cache-Control')).toBe('no-store')
    await expect(input.json()).resolves.toEqual({ error: '內容格式錯誤', code: 'INVALID_REQUEST' })

    const query = await requestWith((c) => mapJsonError(c, new QueryValidationError('請選擇城市'), 'fallback'))
    expect(query.status).toBe(400)
    await expect(query.json()).resolves.toEqual({ error: '請選擇城市' })
  })

  it('distinguishes personal-token rejection from shared upstream failure', async () => {
    const rejected = new TDXServiceError('rejected', 401)
    const personal = await requestWith((c) => mapJsonError(c, rejected, '讀取失敗'), 'Bearer expired-token')
    expect(personal.status).toBe(401)
    await expect(personal.json()).resolves.toMatchObject({ code: TDX_ACCESS_TOKEN_REJECTED_CODE })

    const shared = await requestWith((c) => mapJsonError(c, rejected, '讀取失敗'))
    expect(shared.status).toBe(502)
    await expect(shared.json()).resolves.toEqual({ error: '讀取失敗' })
  })

  it('completes error telemetry with the response status and failure class', async () => {
    const complete = vi.fn(() => true)
    const tracker: ApiOperationTracker = {
      isSampled: true,
      complete,
      completeMissing: vi.fn(() => true),
    }
    const error = new TDXServiceError('rate limited', 429)
    error.warning = 'tdx-rate-limit'

    const response = await requestWith((c) => completeMapError(c, tracker, error, '讀取失敗', 'Taipei'))

    expect(response.status).toBe(502)
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      result: 'error',
      source: 'none',
      failureClass: 'tdx_429',
      httpStatus: 502,
      city: 'Taipei',
    }))
  })
})
