import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TDXServiceError } from '../lib/tdx'
import type { TelemetryEnvelope } from '../observability/telemetry'
import type { MapEnv } from './map-http-context'
import { readRouteCatalog } from './map-route-catalog'

const repository = vi.hoisted(() => ({
  getSnapshotRouteCatalog: vi.fn(),
  getActiveSnapshotVersion: vi.fn(),
}))
const tdx = vi.hoisted(() => ({ getRouteCatalog: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-repository', () => repository)
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  getRouteCatalog: tdx.getRouteCatalog,
}))

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-07-21T13:00:00.000Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
  CF_VERSION_METADATA: metadata,
} as MapEnv['Bindings']

const snapshotRoute = {
  routeUid: 'TPE307',
  routeName: '307',
  departure: '板橋',
  destination: '撫遠街',
  category: 'city-bus',
}
const tdxRoute = {
  routeUid: 'TPE652',
  routeName: '652',
  departure: '新莊',
  destination: '內湖',
  category: 'city-bus',
}

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/routes', readRouteCatalog)
  return app
}

function request(path: string, init: RequestInit = {}): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, init, bindings))
}

function capturedEvent(log: ReturnType<typeof vi.spyOn>): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === 'map_routes',
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

describe('Map route catalog handler', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    Object.values(repository).forEach((mock) => mock.mockReset())
    Object.values(tdx).forEach((mock) => mock.mockReset())
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serves snapshot routes with version, long cache, and success telemetry', async () => {
    repository.getSnapshotRouteCatalog.mockResolvedValue([snapshotRoute])
    repository.getActiveSnapshotVersion.mockResolvedValue('snapshot-v7')

    const response = await request('/api/v1/map/routes?city=Taipei')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 2,
      city: 'Taipei',
      source: 'snapshot',
      snapshotVersion: 'snapshot-v7',
      routes: [snapshotRoute],
    })
    expect(repository.getSnapshotRouteCatalog).toHaveBeenCalledWith(bindings, 'Taipei')
    expect(repository.getActiveSnapshotVersion).toHaveBeenCalledWith(bindings, 'Taipei')
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'success',
      source: 'snapshot',
      snapshotVersion: 'snapshot-v7',
      httpStatus: 200,
      city: 'Taipei',
    })
  })

  it('falls back to TDX with null version, short cache, and degraded telemetry', async () => {
    repository.getSnapshotRouteCatalog.mockResolvedValue([])
    tdx.getRouteCatalog.mockResolvedValue([tdxRoute])

    const response = await request('/api/v1/map/routes?city=Taipei')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 2,
      city: 'Taipei',
      source: 'tdx',
      snapshotVersion: null,
      routes: [tdxRoute],
    })
    expect(repository.getActiveSnapshotVersion).not.toHaveBeenCalled()
    expect(tdx.getRouteCatalog).toHaveBeenCalledWith(expect.objectContaining({
      TDX_CLIENT_ID: 'shared-id',
      TDX_CLIENT_SECRET: 'shared-secret',
    }), 'Taipei')
    expect(capturedEvent(log)).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      snapshotVersion: null,
      httpStatus: 200,
    })
  })

  it('keeps an empty TDX fallback as a successful HTTP response with empty telemetry', async () => {
    repository.getSnapshotRouteCatalog.mockResolvedValue([])
    tdx.getRouteCatalog.mockResolvedValue([])

    const response = await request('/api/v1/map/routes?city=Taipei')

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ source: 'tdx', routes: [] })
    expect(capturedEvent(log)).toMatchObject({
      result: 'empty',
      source: 'fallback',
      emptyReason: 'no_routes',
      httpStatus: 200,
    })
  })

  it('rejects an invalid city before data access and records input validation', async () => {
    const response = await request('/api/v1/map/routes?city=Unknown')

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '請選擇縣市' })
    expect(repository.getSnapshotRouteCatalog).not.toHaveBeenCalled()
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'input_validation',
      httpStatus: 400,
    })
  })

  it('presents repository failures as terminal errors and completes unknown classification', async () => {
    repository.getSnapshotRouteCatalog.mockRejectedValue(new Error('database unavailable'))

    const response = await request('/api/v1/map/routes?city=Taipei')

    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '路線目錄讀取失敗' })
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'unknown',
      httpStatus: 502,
    })
  })

  it('classifies a terminal TDX rate limit without changing the public error contract', async () => {
    repository.getSnapshotRouteCatalog.mockResolvedValue([])
    tdx.getRouteCatalog.mockRejectedValue(new TDXServiceError('rate limited', 429))

    const response = await request('/api/v1/map/routes?city=Taipei')

    expect(response.status).toBe(502)
    await expect(response.json()).resolves.toEqual({ error: '路線目錄讀取失敗' })
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'tdx_429',
      httpStatus: 502,
    })
  })
})
