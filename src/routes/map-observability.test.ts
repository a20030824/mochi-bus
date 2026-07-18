import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetMemoryCacheForTests } from '../lib/memory-cache'
import { resetTDXTestState } from '../lib/tdx'
import type { TelemetryEnvelope, TelemetryOperation } from '../observability/telemetry'
import map from './map'

const releaseSha = '0123456789abcdef0123456789abcdef01234567'
const metadata = {
  id: 'worker-version-id',
  tag: releaseSha,
  timestamp: '2026-07-19T02:15:30.123Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

type DatabaseOptions = {
  activeVersion?: string | null
  routeRows?: Array<Record<string, unknown>>
  journeyRows?: Array<Record<string, unknown>>
  scheduleRouteUid?: string | null
}

function database(options: DatabaseOptions = {}): D1Database {
  const activeVersion = options.activeVersion === undefined ? 'v1' : options.activeVersion
  return {
    prepare(query: string) {
      const statement = {
        bind: () => statement,
        first: async () => {
          if (query.includes('dataset_versions')) {
            return activeVersion ? { active_version: activeVersion } : null
          }
          if (query.includes('FROM routes')) {
            return options.scheduleRouteUid ? { route_uid: options.scheduleRouteUid } : null
          }
          return null
        },
        all: async () => ({
          success: true,
          results: query.includes('FROM routes') ? options.routeRows ?? [] : [],
          meta: {},
        }),
      }
      return statement
    },
    batch: async () => (options.journeyRows ?? []).map((row) => ({
      success: true,
      results: [row],
      meta: {},
    })),
  } as unknown as D1Database
}

function environment(options: {
  database?: D1Database
  placeBundle?: Record<string, unknown> | null
  schedules?: Record<string, unknown>[] | null
} = {}) {
  return {
    TRANSIT_DB: options.database ?? database(),
    TRANSIT_SHAPES: {
      get: vi.fn(async (key: string) => {
        const payload = key.includes('/places/') ? options.placeBundle : options.schedules
        return payload === null || payload === undefined ? null : {
          json: async () => payload,
        }
      }),
    } as unknown as R2Bucket,
    CF_VERSION_METADATA: metadata,
  }
}

function capturedEvent(log: ReturnType<typeof vi.spyOn>, operation: TelemetryOperation): TelemetryEnvelope {
  const event = log.mock.calls
    .map(([value]: unknown[]) => value)
    .find((value: unknown): value is TelemetryEnvelope => Boolean(
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === operation,
    ))
  expect(event).toBeDefined()
  return event as TelemetryEnvelope
}

describe('map API completion callsites', () => {
  let log: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetMemoryCacheForTests()
    resetTDXTestState()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
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
    resetMemoryCacheForTests()
    resetTDXTestState()
  })

  it('records map routes snapshot success and TDX static fallback as different results', async () => {
    const snapshotResponse = await map.request(
      'https://bus.example/api/v1/map/routes?city=Taipei',
      {},
      environment({
        database: database({
          routeRows: [{
            route_uid: 'TPE1',
            route_name: '307',
            departure_name: 'A',
            destination_name: 'B',
          }],
        }),
      }),
    )
    const snapshotBody = await snapshotResponse.json<Record<string, unknown>>()
    const snapshotEvent = capturedEvent(log, 'map_routes')

    expect(snapshotResponse.status).toBe(200)
    expect(snapshotBody).toMatchObject({ source: 'snapshot', snapshotVersion: 'v1' })
    expect(snapshotEvent).toMatchObject({
      result: 'success',
      source: 'snapshot',
      snapshotVersion: 'v1',
      releaseSha,
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      RouteUID: 'TPE1',
      RouteName: { Zh_tw: '307' },
      DepartureStopNameZh: 'A',
      DestinationStopNameZh: 'B',
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))

    const fallbackResponse = await map.request(
      'https://bus.example/api/v1/map/routes?city=Taipei',
      { headers: { Authorization: 'Bearer personal-token' } },
      environment({ database: database({ activeVersion: null }) }),
    )
    const fallbackBody = await fallbackResponse.json<Record<string, unknown>>()
    const fallbackEvent = capturedEvent(log, 'map_routes')

    expect(fallbackResponse.status).toBe(200)
    expect(fallbackBody).toMatchObject({ source: 'tdx' })
    expect(fallbackEvent).toMatchObject({ result: 'degraded', source: 'fallback' })
  })

  it('records vehicles success, distinct empty reasons, upstream degradation, and coded error', async () => {
    const url = 'https://bus.example/api/v1/map/vehicles?city=Taipei&route=307&routeUid=TPE1&direction=0'
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      PlateNumb: 'PRIVATE-PLATE',
      RouteUID: 'TPE1',
      Direction: 0,
      BusPosition: { PositionLat: 25.03, PositionLon: 121.56 },
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const successResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment())
    expect(await successResponse.json()).toMatchObject({ vehicles: [{ plate: 'PRIVATE-PLATE' }] })
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({ result: 'success', source: 'realtime' })
    expect(JSON.stringify(capturedEvent(log, 'map_vehicles'))).not.toContain('PRIVATE-PLATE')

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const emptyResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment())
    expect(await emptyResponse.json()).toMatchObject({ vehicles: [] })
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({
      result: 'empty',
      source: 'realtime',
      emptyReason: 'no_vehicles',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      RouteUID: 'TPE2',
      Direction: 0,
      BusPosition: { PositionLat: 25.03, PositionLon: 121.56 },
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await map.request(url, { headers: { Authorization: 'Bearer personal-token' } }, environment())
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({
      result: 'empty',
      emptyReason: 'identity_mismatch',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      RouteUID: 'TPE1',
      Direction: 0,
      BusPosition: {},
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    await map.request(url, { headers: { Authorization: 'Bearer personal-token' } }, environment())
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({
      result: 'empty',
      emptyReason: 'invalid_coordinates',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const degradedResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment())
    expect(await degradedResponse.json()).toMatchObject({ vehicles: [], warning: 'tdx-rate-limit' })
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      emptyReason: 'upstream_failure',
      failureClass: 'tdx_429',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 401 })))
    const rejectedResponse = await map.request(url, {
      headers: { Authorization: 'Bearer expired-personal-token' },
    }, environment())
    expect(rejectedResponse.status).toBe(401)
    expect(capturedEvent(log, 'map_vehicles')).toMatchObject({ result: 'error', failureClass: 'tdx_401' })
  })

  it('records place realtime success, legal no-arrivals, degraded upstream empty, and coded error', async () => {
    const bundle = {
      version: 'v1',
      placeId: 'private-place-id',
      name: 'Private place name',
      routes: [{
        routeUid: 'TPE1',
        routeName: '307',
        variantKey: 'variant-private',
        direction: 0,
        label: 'A → B',
        subRouteName: '307',
        stopUid: 'STOP1',
        stopSequence: 1,
        stopName: 'Private stop',
        schedules: [],
      }],
    }
    const url = 'https://bus.example/api/v1/map/place/private-place-id/arrivals?city=Taipei'

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      RouteUID: 'TPE1',
      Direction: 0,
      StopUID: 'STOP1',
      EstimateTime: 180,
      StopStatus: 0,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const realtimeResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment({ placeBundle: bundle }))
    expect(await realtimeResponse.json()).toMatchObject({ scheduleSource: 'place-bundle' })
    expect(capturedEvent(log, 'map_place_arrivals')).toMatchObject({
      result: 'success',
      source: 'realtime',
      snapshotVersion: 'v1',
    })
    expect(JSON.stringify(capturedEvent(log, 'map_place_arrivals'))).not.toMatch(
      /private-place-id|Private place name|variant-private|STOP1|Private stop|routeUid|placeId|stopUid|latitude|longitude|plate/i,
    )

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const emptyResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment({ placeBundle: bundle }))
    expect(emptyResponse.status).toBe(200)
    expect(capturedEvent(log, 'map_place_arrivals')).toMatchObject({
      result: 'empty',
      source: 'none',
      emptyReason: 'no_arrivals',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const degradedResponse = await map.request(url, {
      headers: { Authorization: 'Bearer personal-token' },
    }, environment({ placeBundle: bundle }))
    expect(await degradedResponse.json()).toMatchObject({ warning: 'tdx-rate-limit' })
    expect(capturedEvent(log, 'map_place_arrivals')).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      emptyReason: 'upstream_failure',
      failureClass: 'tdx_429',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rejected', { status: 401 })))
    const rejectedResponse = await map.request(url, {
      headers: { Authorization: 'Bearer expired-personal-token' },
    }, environment({ placeBundle: bundle }))
    expect(rejectedResponse.status).toBe(401)
    expect(capturedEvent(log, 'map_place_arrivals')).toMatchObject({ result: 'error', failureClass: 'tdx_401' })
  })

  it('records journey realtime success, all-unknown empty, degraded upstream failure, and validation error', async () => {
    const journeyDatabase = database({
      journeyRows: [{
        route_uid: 'TPE1',
        subroute_uid: null,
        direction: 0,
        route_name: '307',
        stop_uid: 'STOP1',
      }],
      scheduleRouteUid: 'TPE1',
    })
    const url = 'https://bus.example/api/v1/map/journey-eta'
    const request = () => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer personal-token',
      },
      body: JSON.stringify({ city: 'Taipei', legs: [{ key: 'leg-1', patternId: 'pattern-1', sequence: 1 }] }),
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([{
      RouteUID: 'TPE1',
      Direction: 0,
      StopUID: 'STOP1',
      EstimateTime: 180,
      StopStatus: 0,
    }]), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const realtimeResponse = await map.request(url, request(), environment({ database: journeyDatabase }))
    expect(realtimeResponse.status).toBe(200)
    expect(capturedEvent(log, 'map_journey_eta')).toMatchObject({
      result: 'success',
      source: 'realtime',
      qualityBucket: 'complete_realtime',
      city: 'Taipei',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })))
    const emptyResponse = await map.request(url, request(), environment({ database: journeyDatabase }))
    expect(emptyResponse.status).toBe(200)
    expect(capturedEvent(log, 'map_journey_eta')).toMatchObject({
      result: 'empty',
      source: 'none',
      emptyReason: 'all_estimates_unknown',
      qualityBucket: 'all_unknown',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })))
    const degradedResponse = await map.request(url, request(), environment({ database: journeyDatabase }))
    expect(degradedResponse.status).toBe(200)
    expect(capturedEvent(log, 'map_journey_eta')).toMatchObject({
      result: 'degraded',
      source: 'fallback',
      emptyReason: 'upstream_failure',
      qualityBucket: 'all_unknown',
      failureClass: 'tdx_429',
    })

    resetMemoryCacheForTests()
    resetTDXTestState()
    log.mockClear()
    const invalidResponse = await map.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Taipei', legs: [] }),
    }, environment({ database: journeyDatabase }))
    expect(invalidResponse.status).toBe(422)
    expect(capturedEvent(log, 'map_journey_eta')).toMatchObject({
      result: 'error',
      failureClass: 'input_validation',
      httpStatusClass: '4xx',
    })
  })

  it.each([
    ['map_routes', 'https://bus.example/api/v1/map/routes', {}],
    ['map_vehicles', 'https://bus.example/api/v1/map/vehicles?city=Taipei&route=307&direction=3', {}],
    ['map_place_arrivals', 'https://bus.example/api/v1/map/place/p/arrivals?city=invalid', { headers: { Authorization: 'Bearer personal-token' } }],
  ] as const)('records one early validation completion for %s', async (operation, url, init) => {
    const response = await map.request(url, init, environment())

    expect(response.status).toBe(400)
    expect(capturedEvent(log, operation)).toMatchObject({
      result: 'error',
      failureClass: 'input_validation',
      httpStatusClass: '4xx',
    })
    expect(log.mock.calls.filter(([value]: unknown[]) => (
      value && typeof value === 'object'
      && 'event' in value && value.event === 'api_operation_completed'
      && 'operation' in value && value.operation === operation
    ))).toHaveLength(1)
  })

  it('keeps the successful product response when the telemetry sink throws', async () => {
    log.mockImplementation(() => { throw new Error('console unavailable') })
    const response = await map.request(
      'https://bus.example/api/v1/map/routes?city=Taipei',
      {},
      environment({
        database: database({
          routeRows: [{
            route_uid: 'TPE1',
            route_name: '307',
            departure_name: 'A',
            destination_name: 'B',
          }],
        }),
      }),
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ source: 'snapshot', snapshotVersion: 'v1' })
  })
})
