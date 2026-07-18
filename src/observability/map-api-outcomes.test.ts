import { describe, expect, it } from 'vitest'
import type { JourneyEstimate } from '../domain/map/journey-estimate'
import {
  journeyEtaOutcome,
  mapOperationErrorOutcome,
  mapRoutesOutcome,
  placeArrivalsOutcome,
  vehiclesOutcome,
} from './map-api-outcomes'

function estimate(source: JourneyEstimate['source'], minutes: number | null): JourneyEstimate {
  return {
    key: 'not-emitted',
    routeName: 'not-emitted',
    stopUid: 'not-emitted',
    estimateSeconds: minutes === null ? null : minutes * 60,
    minutes,
    stopStatus: null,
    source,
    departureBased: source === 'schedule',
    headwayMinutes: null,
    nextDay: false,
  }
}

describe('map operation semantic outcomes', () => {
  it('classifies map routes snapshot success, static fallback, legal empty, and error', () => {
    expect(mapRoutesOutcome({ snapshotRouteCount: 2, routeCount: 2, snapshotVersion: 'v1' }))
      .toMatchObject({ result: 'success', source: 'snapshot', snapshotVersion: 'v1' })
    expect(mapRoutesOutcome({ snapshotRouteCount: 0, routeCount: 2, snapshotVersion: null }))
      .toMatchObject({ result: 'degraded', source: 'fallback' })
    expect(mapRoutesOutcome({ snapshotRouteCount: 0, routeCount: 0, snapshotVersion: null }))
      .toMatchObject({ result: 'empty', source: 'fallback', emptyReason: 'no_routes' })
    expect(mapOperationErrorOutcome('d1')).toMatchObject({ result: 'error', source: 'none', failureClass: 'd1' })
  })

  it('keeps legal empty vehicles distinct from identity, coordinate, and upstream failures', () => {
    expect(vehiclesOutcome({ upstreamSucceeded: true, rawCount: 2, identityMatchedCount: 2, validVehicleCount: 1 }))
      .toMatchObject({ result: 'success', source: 'realtime' })
    expect(vehiclesOutcome({ upstreamSucceeded: true, rawCount: 0, identityMatchedCount: 0, validVehicleCount: 0 }))
      .toMatchObject({ result: 'empty', emptyReason: 'no_vehicles' })
    expect(vehiclesOutcome({ upstreamSucceeded: true, rawCount: 2, identityMatchedCount: 0, validVehicleCount: 0 }))
      .toMatchObject({ result: 'empty', emptyReason: 'identity_mismatch' })
    expect(vehiclesOutcome({ upstreamSucceeded: true, rawCount: 2, identityMatchedCount: 2, validVehicleCount: 0 }))
      .toMatchObject({ result: 'empty', emptyReason: 'invalid_coordinates' })
    expect(vehiclesOutcome({ upstreamSucceeded: false, rawCount: 0, identityMatchedCount: 0, validVehicleCount: 0, warning: 'tdx-rate-limit' }))
      .toMatchObject({ result: 'degraded', source: 'fallback', emptyReason: 'upstream_failure', failureClass: 'tdx_429' })
    expect(mapOperationErrorOutcome('tdx_401')).toMatchObject({ result: 'error', failureClass: 'tdx_401' })
  })

  it('classifies place arrivals without flattening stale, schedule, mixed, route fallback, or empty', () => {
    expect(placeArrivalsOutcome({ bundleUsed: true, sources: ['realtime'], snapshotVersion: 'v1' }))
      .toMatchObject({ result: 'success', source: 'realtime' })
    expect(placeArrivalsOutcome({ bundleUsed: true, sources: ['stale-realtime'], warning: 'tdx-rate-limit', snapshotVersion: 'v1' }))
      .toMatchObject({ result: 'degraded', source: 'stale', failureClass: 'tdx_429' })
    expect(placeArrivalsOutcome({ bundleUsed: true, sources: ['realtime', 'schedule'], snapshotVersion: 'v1' }))
      .toMatchObject({ result: 'degraded', source: 'mixed' })
    expect(placeArrivalsOutcome({ bundleUsed: false, sources: ['realtime'], snapshotVersion: null }))
      .toMatchObject({ result: 'degraded', source: 'fallback' })
    expect(placeArrivalsOutcome({ bundleUsed: false, sources: ['none'], snapshotVersion: null }))
      .toMatchObject({ result: 'degraded', source: 'fallback', emptyReason: 'route_object_fallback' })
    expect(placeArrivalsOutcome({ bundleUsed: true, sources: ['none'], snapshotVersion: 'v1' }))
      .toMatchObject({ result: 'empty', source: 'none', emptyReason: 'no_arrivals' })
    expect(mapOperationErrorOutcome('tdx_401')).toMatchObject({ result: 'error', failureClass: 'tdx_401' })
  })

  it('classifies journey realtime, schedule/mixed, partial unknown, all unknown, and error', () => {
    expect(journeyEtaOutcome({ estimates: [estimate('realtime', 3)] }))
      .toMatchObject({ result: 'success', source: 'realtime', qualityBucket: 'complete_realtime' })
    expect(journeyEtaOutcome({ estimates: [estimate('realtime', 3), estimate('schedule', 8)] }))
      .toMatchObject({ result: 'degraded', source: 'mixed', qualityBucket: 'complete_mixed' })
    expect(journeyEtaOutcome({ estimates: [estimate('schedule', 8)] }))
      .toMatchObject({ result: 'degraded', source: 'schedule', qualityBucket: 'complete_schedule' })
    expect(journeyEtaOutcome({ estimates: [estimate('realtime', 3), undefined] }))
      .toMatchObject({ result: 'degraded', source: 'realtime', qualityBucket: 'partial_unknown' })
    expect(journeyEtaOutcome({ estimates: [estimate('realtime', 3)], expectedCount: 2 }))
      .toMatchObject({ result: 'degraded', source: 'realtime', qualityBucket: 'partial_unknown' })
    expect(journeyEtaOutcome({ estimates: [estimate('none', null)] }))
      .toMatchObject({ result: 'empty', source: 'none', emptyReason: 'all_estimates_unknown', qualityBucket: 'all_unknown' })
    expect(journeyEtaOutcome({ estimates: [estimate('none', null)], warning: 'tdx-unavailable' }))
      .toMatchObject({ result: 'degraded', source: 'fallback', emptyReason: 'upstream_failure', qualityBucket: 'all_unknown' })
    expect(mapOperationErrorOutcome('input_validation')).toMatchObject({ result: 'error', failureClass: 'input_validation' })
  })
})
