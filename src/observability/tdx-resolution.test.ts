import { describe, expect, it, vi } from 'vitest'
import { releaseIdentity } from './release-identity'
import { beginTDXResolutionTelemetry, dataAgeBucket, ORGANIC_TDX_SAMPLE_PROBABILITY } from './tdx-resolution'
import type { TelemetryEnvelope } from './telemetry'

const identity = releaseIdentity({
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-07-19T02:15:30.123Z',
})

describe('TDX resolution tracker', () => {
  it('emits one authoritative completion with retry recovery metadata', () => {
    const events: TelemetryEnvelope[] = []
    const now = vi.fn().mockReturnValueOnce(1_000).mockReturnValueOnce(1_240)
    const tracker = beginTDXResolutionTelemetry({
      tdxOperation: 'vehicle_positions',
      credentialScope: 'byok',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      random: () => 0,
      now,
      emitter: (event) => events.push(event),
    })

    expect(tracker.complete({
      resolution: 'upstream',
      result: 'success',
      retryCount: 1,
      initialFailureClass: 'timeout',
      recoveredAfterRetry: true,
      dataAgeMilliseconds: 0,
      upstreamStatus: 200,
    })).toBe(true)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      event: 'tdx_resolution_completed',
      tdxOperation: 'vehicle_positions',
      credentialScope: 'byok',
      resolution: 'upstream',
      result: 'success',
      retryCountBucket: '1',
      recoveredAfterRetry: true,
      initialFailureClass: 'timeout',
      failureClass: 'none',
      dataAgeBucket: 'fresh',
      upstreamStatusClass: '2xx',
      latencyBucket: '200_999ms',
      sampleProbability: ORGANIC_TDX_SAMPLE_PROBABILITY,
    })
    expect(tracker.complete({ resolution: 'upstream', result: 'error' })).toBe(false)
  })

  it.each(['success', 'error'] as const)('samples organic %s out with the same decision', (result) => {
    const emitter = vi.fn()
    const tracker = beginTDXResolutionTelemetry({
      tdxOperation: 'route_catalog',
      credentialScope: 'shared',
      city: 'Taipei',
      trafficClass: 'user',
      releaseIdentity: identity,
      random: () => 0.9,
      emitter,
    })

    tracker.complete(result === 'success'
      ? { resolution: 'memory', result, dataAgeMilliseconds: 2_000 }
      : { resolution: 'none', result, failureClass: 'network_error', dataAgeMilliseconds: null })
    expect(tracker.isSampled).toBe(false)
    expect(emitter).not.toHaveBeenCalled()
  })

  it.each(['synthetic', 'snapshot_publish'] as const)('%s is always sampled', (trafficClass) => {
    const emitter = vi.fn()
    const tracker = beginTDXResolutionTelemetry({
      tdxOperation: 'tdx_schedule',
      credentialScope: 'shared',
      city: null,
      trafficClass,
      releaseIdentity: identity,
      random: () => 0.999,
      emitter,
    })
    tracker.complete({ resolution: 'edge', result: 'empty', dataAgeMilliseconds: 30_000 })
    expect(emitter).toHaveBeenCalledWith(expect.objectContaining({ sampleProbability: 1, trafficClass }))
  })

  it('fails open when the sink throws and never emits request identity', () => {
    const tracker = beginTDXResolutionTelemetry({
      tdxOperation: 'place_arrivals',
      credentialScope: 'byok',
      city: 'Taipei',
      trafficClass: 'synthetic',
      releaseIdentity: identity,
      emitter: () => { throw new Error('sink unavailable') },
    })
    expect(() => tracker.complete({
      resolution: 'circuit_open',
      result: 'error',
      failureClass: 'circuit_open',
      dataAgeMilliseconds: null,
    })).not.toThrow()
  })

  it('uses bounded data-age buckets', () => {
    expect([0, 999, 1_000, 59_999, 60_000, 300_000, 1_800_000, 21_600_000].map(dataAgeBucket))
      .toEqual(['fresh', 'fresh', 'lt_1m', 'lt_1m', '1_5m', '5_30m', '30m_6h', 'gt_6h'])
    expect(dataAgeBucket(undefined)).toBe('unknown')
    expect(dataAgeBucket(null)).toBe('not_applicable')
  })
})
