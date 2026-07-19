import { describe, expect, it } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import { deterministicSampleCaseId, deterministicSampleIndex } from './active-probe.mjs'
import {
  createPublicProbeEvent,
  deterministicPublicCaseIndex,
  PUBLIC_PROBE_CASE_VERSION,
  PUBLIC_PROBE_HARD_CHECK_COUNT,
  publicProbeFailureResult,
  publicSampleCaseId,
  validatePublicProbeResult,
} from './public-probe-contract.mjs'

const probeDate = '2026-07-19'
const evaluatedAt = '2026-07-19T00:20:00.000Z'

function result(overrides = {}) {
  return validatePublicProbeResult({
    city: 'Taipei',
    probeDate,
    evaluatedAt,
    status: 'healthy',
    activeVersion: 'v1',
    observedVersion: 'v1',
    failureClass: 'none',
    hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
    realtimeWarnings: [],
    probeCaseVersion: PUBLIC_PROBE_CASE_VERSION,
    sampleCaseId: publicSampleCaseId('Taipei', probeDate, PUBLIC_PROBE_CASE_VERSION),
    latencyBucket: '1_3s',
    ...overrides,
  })
}

describe('public probe contract', () => {
  it('rotates deterministically but never shares a case series with the publisher probe', () => {
    const index = deterministicPublicCaseIndex('Taipei', probeDate, 1, 97)
    expect(deterministicPublicCaseIndex('Taipei', probeDate, 1, 97)).toBe(index)
    expect(deterministicPublicCaseIndex('Taipei', '2026-07-26', 1, 97)).not.toBe(index)
    // Same city, same date-like key, same case version: A5b and A6b must not
    // permanently probe the identical sample.
    expect(publicSampleCaseId('Taipei', probeDate, 1))
      .not.toBe(deterministicSampleCaseId('Taipei', probeDate, 1))
    expect(deterministicPublicCaseIndex('Taipei', probeDate, 1, 1_000_003))
      .not.toBe(deterministicSampleIndex('Taipei', probeDate, 1, 1_000_003))
  })

  it('keeps snapshot hard health and realtime health on separate planes', () => {
    const degraded = result({
      status: 'realtime_degraded',
      failureClass: 'journey_estimate_unknown',
      realtimeWarnings: ['realtime_schedule_only', 'journey_estimate_unknown'],
    })
    expect(degraded.hardChecksPassed).toBe(PUBLIC_PROBE_HARD_CHECK_COUNT)
    expect(degraded.realtimeWarnings).toEqual(['journey_estimate_unknown', 'realtime_schedule_only'])
    const event = createPublicProbeEvent(degraded)
    expect(event).toMatchObject({ result: 'degraded', source: 'snapshot', failureClass: 'journey_estimate_unknown' })
  })

  it('rejects a healthy status that skipped hard checks or carries warnings', () => {
    expect(() => result({ hardChecksPassed: 9 })).toThrow()
    expect(() => result({ realtimeWarnings: ['realtime_schedule_only'] })).toThrow()
    expect(() => result({ status: 'realtime_degraded', failureClass: 'none', realtimeWarnings: [] })).toThrow()
  })

  it('requires hard failures to name a hard class and stay below full checks', () => {
    const hard = result({
      status: 'hard_failed', failureClass: 'public_version_mismatch',
      hardChecksPassed: 5, observedVersion: 'v0',
    })
    expect(createPublicProbeEvent(hard)).toMatchObject({ result: 'error', source: 'none' })
    expect(() => result({ status: 'hard_failed', failureClass: 'realtime_schedule_only', hardChecksPassed: 5 }))
      .toThrow()
    expect(() => result({ status: 'hard_failed', failureClass: 'public_version_mismatch' })).toThrow()
  })

  it('classifies infrastructure trouble as unknown, never as a red city', () => {
    const unknown = publicProbeFailureResult({
      city: 'Taipei', probeDate, evaluatedAt, failureClass: 'probe_rate_limited',
    })
    expect(unknown).toMatchObject({ status: 'unknown', failureClass: 'probe_rate_limited' })
    expect(publicProbeFailureResult({
      city: 'Taipei', probeDate, evaluatedAt, failureClass: 'public_version_mismatch',
    })).toMatchObject({ status: 'unknown', failureClass: 'unknown' })
    expect(publicProbeFailureResult({
      city: 'Taipei', probeDate, evaluatedAt, failureClass: 'record_write_failed',
    })).toMatchObject({ status: 'record_write_failed' })
  })

  it('creates exactly one strict privacy-safe completion event', () => {
    const event = createPublicProbeEvent(result(), '0123456789abcdef0123456789abcdef01234567')
    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      event: 'public_probe_completed',
      operation: 'public_probe',
      result: 'success',
      trafficClass: 'synthetic',
      sampleProbability: 1,
      hardChecksPassed: PUBLIC_PROBE_HARD_CHECK_COUNT,
    })
    expect(JSON.stringify(event)).not.toMatch(/route=|place\/|https?:|authorization|token|stack|message/i)
  })
})
