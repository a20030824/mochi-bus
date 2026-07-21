import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import { TDXServiceError } from '../lib/tdx'
import type { TelemetryEnvelope } from '../observability/telemetry'
import type { MapEnv } from './map-http-context'
import { readVehicles } from './map-vehicles-read'

const tdx = vi.hoisted(() => ({ fetchTDXJson: vi.fn() }))

vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  fetchTDXJson: tdx.fetchTDXJson,
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

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/vehicles', readVehicles)
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
      && 'operation' in value && value.operation === 'map_vehicles',
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

const validVehicle = {
  PlateNumb: 'AAA-001',
  RouteUID: 'TPE307',
  Direction: 0,
  BusPosition: { PositionLat: 25.03, PositionLon: 121.56 },
  Speed: 28,
  Azimuth: 180,
  GPSTime: '2026-07-21T13:00:00+08:00',
}

const secondValidVehicle = {
  RouteUID: 'TPE307',
  Direction: 0,
  BusPosition: { PositionLat: 25.04, PositionLon: 121.57 },
  UpdateTime: '2026-07-21T13:00:05+08:00',
}

describe('Map vehicles read handler', () => {
  let log: ReturnType<typeof vi.spyOn>
  let errorLog: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    tdx.fetchTDXJson.mockReset()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('filters identities and invalid coordinates while preserving the public realtime contract', async () => {
    tdx.fetchTDXJson.mockResolvedValue([
      validVehicle,
      secondValidVehicle,
      { ...validVehicle, PlateNumb: 'WRONG-ROUTE', RouteUID: 'TPE652' },
      { ...validVehicle, PlateNumb: 'WRONG-DIRECTION', Direction: 1 },
      { ...validVehicle, PlateNumb: 'INVALID-COORDINATE', BusPosition: { PositionLat: Number.NaN, PositionLon: 121.56 } },
    ])

    const response = await request(
      '/api/v1/map/vehicles?city=Taipei&route=307&routeUid=TPE307&direction=0',
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=15')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      vehicles: [{
        plate: 'AAA-001',
        latitude: 25.03,
        longitude: 121.56,
        speed: 28,
        azimuth: 180,
        gpsTime: '2026-07-21T13:00:00+08:00',
      }, {
        plate: null,
        latitude: 25.04,
        longitude: 121.57,
        speed: null,
        azimuth: null,
        gpsTime: '2026-07-21T13:00:05+08:00',
      }],
    })

    expect(tdx.fetchTDXJson).toHaveBeenCalledTimes(1)
    const [env, url, ttl, options] = tdx.fetchTDXJson.mock.calls[0]
    expect(env).toMatchObject({ TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' })
    expect(url).toBeInstanceOf(URL)
    expect(String(url)).toContain('/Bus/RealTimeByFrequency/')
    expect(String(url)).toContain('/307?%24format=JSON')
    expect(ttl).toBe(15)
    expect(options).toMatchObject({ operation: 'vehicle_positions', city: 'Taipei' })
    expect(capturedEvent(log)).toMatchObject({
      result: 'success',
      source: 'realtime',
      failureClass: 'none',
      emptyReason: 'not_applicable',
      city: 'Taipei',
    })
    expect(JSON.stringify(capturedEvent(log))).not.toContain('AAA-001')
  })

  it('uses no-store and forwards a personal access token on successful BYOK requests', async () => {
    tdx.fetchTDXJson.mockResolvedValue([validVehicle])

    const response = await request('/api/v1/map/vehicles?city=Taipei&route=307', {
      headers: { Authorization: 'Bearer personal-token' },
    })

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(tdx.fetchTDXJson.mock.calls[0][0]).toMatchObject({
      TDX_USER_ACCESS_TOKEN: 'personal-token',
    })
  })

  it('degrades ordinary upstream failures to a warning response with no-store telemetry', async () => {
    tdx.fetchTDXJson.mockRejectedValue(new Error('network unavailable'))

    const response = await request('/api/v1/map/vehicles?city=Taipei&route=307')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      vehicles: [],
      warning: 'tdx-unavailable',
    })
    expect(capturedEvent(log)).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      failureClass: 'unknown',
      emptyReason: 'upstream_failure',
    })
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('vehicle_position_upstream_failed'))
  })

  it('keeps identity mismatch and invalid coordinates as distinct empty outcomes', async () => {
    tdx.fetchTDXJson.mockResolvedValueOnce([
      { ...validVehicle, RouteUID: 'TPE652' },
    ])

    const identityResponse = await request(
      '/api/v1/map/vehicles?city=Taipei&route=307&routeUid=TPE307&direction=0',
    )
    expect(identityResponse.status).toBe(200)
    expect(capturedEvent(log)).toMatchObject({
      result: 'empty',
      source: 'realtime',
      emptyReason: 'identity_mismatch',
    })

    log.mockClear()
    tdx.fetchTDXJson.mockResolvedValueOnce([{
      ...validVehicle,
      BusPosition: { PositionLat: 25.03, PositionLon: Number.POSITIVE_INFINITY },
    }])

    const coordinateResponse = await request(
      '/api/v1/map/vehicles?city=Taipei&route=307&routeUid=TPE307&direction=0',
    )
    expect(coordinateResponse.status).toBe(200)
    expect(capturedEvent(log)).toMatchObject({
      result: 'empty',
      source: 'realtime',
      emptyReason: 'invalid_coordinates',
    })
  })

  it('rejects invalid request identity before upstream access', async () => {
    const response = await request('/api/v1/map/vehicles?city=Unknown&route=307')

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '請選擇縣市' })
    expect(tdx.fetchTDXJson).not.toHaveBeenCalled()
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'input_validation',
    })
  })

  it('preserves the route-name validation contract', async () => {
    const response = await request('/api/v1/map/vehicles?city=Taipei&route=')

    expect(response.status).toBe(400)
    await expect(response.json()).resolves.toEqual({ error: '路線格式錯誤' })
    expect(tdx.fetchTDXJson).not.toHaveBeenCalled()
  })

  it('keeps rejected personal tokens terminal and coded', async () => {
    tdx.fetchTDXJson.mockRejectedValue(new TDXServiceError('token rejected', 401))

    const response = await request('/api/v1/map/vehicles?city=Taipei&route=307', {
      headers: { Authorization: 'Bearer rejected-token' },
    })

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      code: TDX_ACCESS_TOKEN_REJECTED_CODE,
      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
    })
    expect(capturedEvent(log)).toMatchObject({
      result: 'error',
      source: 'none',
      failureClass: 'tdx_401',
    })
    expect(errorLog).not.toHaveBeenCalled()
  })
})
