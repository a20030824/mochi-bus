import { describe, expect, it, vi } from 'vitest'
import {
  emitTelemetry,
  errorFingerprint,
  httpStatusClass,
  latencyBucket,
  parseTelemetryEvent,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryEnvelope,
} from './telemetry'

function validEvent(overrides: Partial<TelemetryEnvelope> = {}): TelemetryEnvelope {
  return {
    eventSchema: TELEMETRY_EVENT_SCHEMA,
    event: 'api_operation_completed',
    releaseSha: null,
    workerVersionId: null,
    workerCreatedAt: null,
    deploymentId: null,
    city: 'Taipei',
    operation: 'map_routes',
    result: 'success',
    source: 'snapshot',
    snapshotVersion: '2026-07-19T03:17:00Z',
    httpStatusClass: '2xx',
    latencyBucket: '50_199ms',
    cacheResult: 'edge_hit',
    trafficClass: 'user',
    sampleProbability: 0.1,
    failureClass: 'none',
    emptyReason: 'not_applicable',
    qualityBucket: 'not_applicable',
    ...overrides,
  }
}

describe('telemetry contract', () => {
  it('accepts and freezes an allowlisted common envelope', () => {
    const event = parseTelemetryEvent(validEvent())

    expect(event).toEqual(validEvent())
    expect(Object.isFrozen(event)).toBe(true)
  })

  it('requires every denominator field and rejects unknown enum values', () => {
    const missingResult = { ...validEvent() } as Record<string, unknown>
    delete missingResult.result

    expect(parseTelemetryEvent(missingResult)).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), operation: 'arbitrary_path' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'ok' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), sampleProbability: 0 })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), releaseSha: '0123456' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'empty' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), result: 'error', failureClass: 'none' })).toBeUndefined()
  })

  it.each([
    ['Authorization', 'Bearer secret'],
    ['accessToken', 'token'],
    ['clientSecret', 'secret'],
    ['credentialFingerprint', 'fingerprint'],
    ['ip', '203.0.113.10'],
    ['ipHash', 'hash'],
    ['latitude', 25.033],
    ['longitude', 121.5654],
    ['url', 'https://bus.example/map?place=private'],
    ['query', 'route=307'],
    ['searchText', 'home address'],
    ['requestBody', { route: '307' }],
    ['responseBody', { token: 'secret' }],
    ['plate', 'ABC-1234'],
    ['boardId', 'board-private'],
    ['journeyId', 'journey-private'],
    ['error', 'raw failure'],
    ['message', 'raw failure'],
    ['cause', 'raw cause'],
    ['stack', 'raw stack'],
  ])('rejects the prohibited %s field instead of silently sanitizing it', (key, value) => {
    expect(parseTelemetryEvent({ ...validEvent(), [key]: value })).toBeUndefined()
  })

  it('rejects sensitive markers smuggled through an otherwise allowed identifier', () => {
    expect(parseTelemetryEvent({ ...validEvent(), deploymentId: 'client-secret' })).toBeUndefined()
    expect(parseTelemetryEvent({ ...validEvent(), snapshotVersion: 'access_token' })).toBeUndefined()
  })
})

describe('telemetry helpers', () => {
  it('emits the validated object and fails open when validation or the sink fails', () => {
    const sink = vi.fn()

    expect(emitTelemetry(validEvent(), sink)).toBe(true)
    expect(sink).toHaveBeenCalledWith(validEvent())
    expect(emitTelemetry({ ...validEvent(), stack: 'private' }, sink)).toBe(false)
    expect(() => emitTelemetry(validEvent(), () => { throw new Error('console unavailable') })).not.toThrow()
    expect(emitTelemetry(validEvent(), () => { throw new Error('console unavailable') })).toBe(false)
  })

  it('does not affect the caller when the default console sink throws', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => { throw new Error('console unavailable') })

    expect(() => emitTelemetry(validEvent())).not.toThrow()
    expect(emitTelemetry(validEvent())).toBe(false)
    log.mockRestore()
  })

  it('uses stable latency and HTTP status buckets', () => {
    expect([49, 50, 199, 200, 999, 1_000, 2_999, 3_000, 6_000, 6_001].map(latencyBucket))
      .toEqual(['lt_50ms', '50_199ms', '50_199ms', '200_999ms', '200_999ms', '1_3s', '1_3s', '3_6s', '3_6s', 'gt_6s'])
    expect(latencyBucket(Number.NaN)).toBe('unknown')
    expect(httpStatusClass(204)).toBe('2xx')
    expect(httpStatusClass(429)).toBe('4xx')
    expect(httpStatusClass(503)).toBe('5xx')
    expect(httpStatusClass(undefined)).toBe('none')
  })

  it('fingerprints only sanitized error type, asset basename, and line bucket', async () => {
    const first = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://bus.example/assets/map-abc123.js?Authorization=Bearer-secret',
      line: 38,
    })
    const sameSafeParts = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://other.example/private/assets/map-abc123.js?token=another-secret',
      line: 49,
    })
    const nextLineBucket = await errorFingerprint({
      errorType: 'TypeError',
      assetUrl: 'https://bus.example/assets/map-abc123.js',
      line: 51,
    })

    expect(first).toMatch(/^err_[a-f0-9]{16}$/)
    expect(first).toBe(sameSafeParts)
    expect(first).not.toBe(nextLineBucket)
    expect(first).not.toMatch(/Authorization|Bearer|secret|bus\.example|private/)
  })

  it('collapses arbitrary error labels and non-asset paths to safe fallback values', async () => {
    const arbitrary = await errorFingerprint({
      errorType: 'HomeAddressFromUser',
      assetUrl: 'https://example.test/private/home-address',
      line: 7,
    })
    const fallback = await errorFingerprint({ errorType: 'Error', line: 7 })

    expect(arbitrary).toBe(fallback)
  })
})
