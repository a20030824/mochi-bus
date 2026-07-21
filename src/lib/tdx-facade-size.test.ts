/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import tdxSource from './tdx.ts?raw'
import scheduleSource from './tdx/schedule-endpoint.ts?raw'

const TDX_FACADE_LINE_LIMIT = 206

const COMPOSITION_FACTORIES = [
  'createTDXCircuitBreaker',
  'createTDXTokenClient',
  'createTDXUpstreamDataClient',
  'createTDXResolutionCache',
  'createTDXBusRouteQueries',
  'createTDXScheduleEndpoint',
  'createTDXCommuteRoutePresentation',
]

describe('TDX compatibility façade architecture boundary', () => {
  it('does not grow beyond the completed Phase 4 composition root', () => {
    expect(tdxSource.split(/\r?\n/).length).toBeLessThanOrEqual(TDX_FACADE_LINE_LIMIT)
  })

  it('keeps the façade focused on compatibility exports and boundary composition', () => {
    for (const factory of COMPOSITION_FACTORIES) expect(tdxSource).toContain(factory)
    expect(tdxSource).toContain('async function tdxResponseError(')
    expect(tdxSource).toContain('export function resetTDXTestState()')

    for (const implementation of [
      'new URL(',
      '/Bus/Schedule/',
      "operation: 'tdx_schedule'",
      'supportedCityCodes',
      'function isRecordArrayPayload',
      'export async function getBusSchedule',
    ]) {
      expect(tdxSource).not.toContain(implementation)
    }
  })

  it('delegates the complete schedule endpoint policy to its boundary', () => {
    for (const marker of [
      '/Bus/Schedule/',
      "operation: 'tdx_schedule'",
      'SCHEDULE_CACHE_SECONDS',
      'tdxRouteScope(',
      'tdxTelemetryCity(',
      'isTDXRecordArray',
    ]) {
      expect(scheduleSource).toContain(marker)
    }

    for (const dependency of [
      'createTDXTokenClient',
      'createTDXCircuitBreaker',
      'createTDXUpstreamDataClient',
      'createTDXResolutionCache',
      'getSnapshotSchedule',
      'commute-route-presentation',
      '../tdx.ts',
    ]) {
      expect(scheduleSource).not.toContain(dependency)
    }
  })
})
