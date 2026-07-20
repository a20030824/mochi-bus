import { Hono } from 'hono'
import { describe, expect, it, vi } from 'vitest'
import type { RoutePage } from '../application/route-page'
import { ROUTE_IDENTITY_SCRIPT_ID } from '../domain/route-page-identity'
import {
  QueryResolutionError,
  TDXServiceError,
  tdxWarningMessages,
} from '../lib/tdx'
import { createRoutePageHandler } from './bus'

const routeUrl = 'https://example.com/route?city=Taipei&route=307&direction=0&stop=捷運西門站&stopUid=STOP-2&routeUid=ROUTE-A&subRouteUid=SUB-A'
const bindings = {
  TDX_CLIENT_ID: 'test-client',
  TDX_CLIENT_SECRET: 'test-secret',
  TRANSIT_DB: {},
  TRANSIT_SHAPES: {},
}

function routePage(label: string): RoutePage {
  return {
    resolved: {
      city: 'Taipei',
      routeName: '307',
      routeUid: 'ROUTE-A',
      subRouteUid: 'SUB-A',
      direction: 0,
      stopUid: 'STOP-2',
      stopName: '捷運西門站',
    },
    detail: {
      routeName: '307',
      direction: 0,
      label,
      stops: [
        {
          stopUid: 'STOP-1',
          stopName: '板橋公車站',
          sequence: 1,
          selected: false,
          etaLabel: '—',
          etaTone: 'muted',
        },
        {
          stopUid: 'STOP-2',
          stopName: '捷運西門站',
          sequence: 2,
          selected: true,
          etaLabel: '更新中',
          etaTone: 'muted',
        },
      ],
    },
  }
}

function createTestApp(loader: () => Promise<RoutePage>) {
  const app = new Hono<any>()
  const getRoutePageWithFallback = vi.fn(loader)
  app.get('/route', createRoutePageHandler({
    getRoutePageWithFallback: getRoutePageWithFallback as unknown as Parameters<typeof createRoutePageHandler>[0]['getRoutePageWithFallback'],
  }))
  return { app, getRoutePageWithFallback }
}

async function requestRoute(loader: () => Promise<RoutePage>) {
  const test = createTestApp(loader)
  const response = await test.app.request(routeUrl, undefined, bindings)
  return { ...test, response, body: await response.text() }
}

describe('/route HTTP contract', () => {
  it('renders a primary TDX page with identity and no-store headers', async () => {
    const { response, body, getRoutePageWithFallback } = await requestRoute(async () => routePage('TDX 板橋 → 撫遠街'))

    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
    expect(body).toContain('TDX 板橋 → 撫遠街')
    expect(body).toContain(`id="${ROUTE_IDENTITY_SCRIPT_ID}"`)
    expect(body).toContain('"stopUid":"STOP-2"')
    expect(body).toContain('"selected":true')
    expect(getRoutePageWithFallback).toHaveBeenCalledOnce()
  })

  it('renders a Snapshot fallback page through the same HTTP contract', async () => {
    const { response, body } = await requestRoute(async () => routePage('Snapshot 板橋 → 撫遠街'))

    expect(response.status).toBe(200)
    expect(body).toContain('Snapshot 板橋 → 撫遠街')
    expect(body).toContain(`id="${ROUTE_IDENTITY_SCRIPT_ID}"`)
    expect(body).toContain('更新中')
  })

  it('maps the preserved query-resolution error to the existing 404 page', async () => {
    const error = new QueryResolutionError('找不到這個方向的完整站序')
    const { response, body } = await requestRoute(async () => { throw error })

    expect(response.status).toBe(404)
    expect(body).toContain('找不到這班公車')
    expect(body).toContain('找不到這個方向的完整站序')
  })

  it('maps a preserved TDX rate-limit error to 429', async () => {
    const error = new TDXServiceError('TDX rate limited', 429)
    const { response, body } = await requestRoute(async () => { throw error })

    expect(response.status).toBe(429)
    expect(body).toContain('暫時無法取得公車資料')
    expect(body).toContain(tdxWarningMessages['tdx-rate-limit'])
  })

  it('maps a preserved general TDX failure to 503', async () => {
    const error = new TDXServiceError('TDX unavailable', 503)
    const { response, body } = await requestRoute(async () => { throw error })

    expect(response.status).toBe(503)
    expect(body).toContain('暫時無法取得公車資料')
    expect(body).toContain(tdxWarningMessages['tdx-unavailable'])
  })

  it('rejects an invalid query with 400 before calling the page loader', async () => {
    const { app, getRoutePageWithFallback } = createTestApp(async () => routePage('unreachable'))
    const response = await app.request('https://example.com/route?city=Taipei&route=307&direction=0', undefined, bindings)
    const body = await response.text()

    expect(response.status).toBe(400)
    expect(body).toContain('缺少站牌名稱或 StopUID')
    expect(getRoutePageWithFallback).not.toHaveBeenCalled()
  })
})
