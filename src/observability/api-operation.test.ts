import { describe, expect, it, vi } from 'vitest'
import { releaseIdentity } from './release-identity'
import { beginApiOperationTelemetry, ORGANIC_API_SAMPLE_PROBABILITY } from './api-operation'
import type { TelemetryEnvelope } from './telemetry'

const releaseSha = '0123456789abcdef0123456789abcdef01234567'
const identity = releaseIdentity({
  id: 'worker-version-id',
  tag: releaseSha,
  timestamp: '2026-07-19T02:15:30.123Z',
})

function successOutcome() {
  return {
    result: 'success' as const,
    source: 'snapshot' as const,
    httpStatus: 200,
  }
}

describe('API operation telemetry tracker', () => {
  it('emits one sampled success with stable latency and the A2 release identity', () => {
    const events: TelemetryEnvelope[] = []
    const now = vi.fn()
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_250)
    const tracker = beginApiOperationTelemetry({
      operation: 'map_routes',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      now,
      random: () => 0,
      emitter: (event) => events.push(event),
    })

    expect(tracker.isSampled).toBe(true)
    expect(tracker.complete(successOutcome())).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'api_operation_completed',
      releaseSha,
      workerVersionId: 'worker-version-id',
      operation: 'map_routes',
      result: 'success',
      latencyBucket: '1_3s',
      sampleProbability: ORGANIC_API_SAMPLE_PROBABILITY,
      cacheResult: 'unknown',
      emptyReason: 'not_applicable',
      qualityBucket: 'not_applicable',
    })
  })

  it('completes at most once even if a fallback path calls complete again', () => {
    const emitter = vi.fn()
    const tracker = beginApiOperationTelemetry({
      operation: 'map_place_arrivals',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      random: () => 0,
      emitter,
    })

    expect(tracker.complete({
      result: 'degraded',
      source: 'schedule',
      httpStatus: 200,
    })).toBe(true)
    expect(tracker.complete({
      result: 'error',
      source: 'none',
      httpStatus: 502,
      failureClass: 'unknown',
    })).toBe(false)
    expect(emitter).toHaveBeenCalledTimes(1)
  })

  it.each(['success', 'error'] as const)(
    'samples out organic %s with the same cohort decision',
    (result) => {
      const emitter = vi.fn()
      const tracker = beginApiOperationTelemetry({
        operation: 'map_vehicles',
        city: 'Taipei',
        trafficClass: 'user',
        releaseIdentity: identity,
        random: () => 0.9,
        emitter,
      })

      expect(tracker.isSampled).toBe(false)
      expect(tracker.complete(result === 'success' ? {
        result,
        source: 'realtime',
        httpStatus: 200,
      } : {
        result,
        source: 'none',
        httpStatus: 401,
        failureClass: 'tdx_401',
      })).toBe(false)
      expect(emitter).not.toHaveBeenCalled()
    },
  )

  it.each(['synthetic', 'snapshot_publish'] as const)('%s traffic is always emitted', (trafficClass) => {
    const emitter = vi.fn()
    const tracker = beginApiOperationTelemetry({
      operation: 'map_journey_eta',
      city: null,
      trafficClass,
      releaseIdentity: identity,
      random: () => 0.999,
      emitter,
    })

    expect(tracker.isSampled).toBe(true)
    expect(tracker.complete(successOutcome())).toBe(true)
    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({
      trafficClass,
      sampleProbability: 1,
    }))
  })

  it('fails open when the emitter or clock fails and drops unsafe snapshot metadata', () => {
    const tracker = beginApiOperationTelemetry({
      operation: 'map_routes',
      city: 'Taipei',
      trafficClass: 'synthetic',
      releaseIdentity: identity,
      snapshotVersion: 'access_token_private',
      now: () => { throw new Error('clock unavailable') },
      random: () => { throw new Error('unused for synthetic') },
      emitter: () => { throw new Error('sink unavailable') },
    })

    expect(() => tracker.complete(successOutcome())).not.toThrow()
    expect(tracker.complete(successOutcome())).toBe(false)
  })

  it('samples organic traffic out when the random source fails', () => {
    const emitter = vi.fn()
    const tracker = beginApiOperationTelemetry({
      operation: 'map_routes',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      random: () => { throw new Error('random unavailable') },
      emitter,
    })

    expect(tracker.isSampled).toBe(false)
    expect(() => tracker.complete(successOutcome())).not.toThrow()
    expect(emitter).not.toHaveBeenCalled()
  })

  it('emits a coded error without raw credentials or request identity', () => {
    const events: TelemetryEnvelope[] = []
    const tracker = beginApiOperationTelemetry({
      operation: 'map_vehicles',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      random: () => 0,
      emitter: (event) => events.push(event),
    })

    tracker.complete({
      result: 'error',
      source: 'none',
      httpStatus: 401,
      failureClass: 'tdx_401',
    })

    expect(events[0]).toMatchObject({ failureClass: 'tdx_401', httpStatusClass: '4xx' })
    expect(JSON.stringify(events[0])).not.toMatch(/Bearer|token|Authorization|placeId|routeUid|stopUid|plate|latitude|longitude|url|query|stack|message/i)
  })

  it('provides an explicit completion-missing guard without auto-guessing in finally', () => {
    const emitter = vi.fn()
    const tracker = beginApiOperationTelemetry({
      operation: 'map_routes',
      city: null,
      trafficClass: 'synthetic',
      releaseIdentity: identity,
      emitter,
    })

    expect(tracker.completeMissing()).toBe(true)
    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({
      result: 'error',
      failureClass: 'completion_missing',
      httpStatusClass: '5xx',
    }))
  })

  it('lets the final outcome clear start-time snapshot context instead of retaining stale metadata', () => {
    const emitter = vi.fn()
    const tracker = beginApiOperationTelemetry({
      operation: 'map_routes',
      city: 'Taipei',
      trafficClass: 'synthetic',
      releaseIdentity: identity,
      snapshotVersion: 'v1',
      emitter,
    })

    tracker.complete({ ...successOutcome(), source: 'fallback', result: 'degraded', snapshotVersion: null })

    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({ snapshotVersion: null }))
  })
})
