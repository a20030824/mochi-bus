import { describe, expect, it } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import {
  createWindowWatchdogEvent,
  evaluateWindowWatchdog,
  WATCHDOG_MAX_PROBE_AGE_MS,
} from './watchdog-contract.mjs'

const evaluatedAt = '2026-07-19T23:45:00.000Z'
const windowId = 'v1:Taipei:2026-07-20:0317'

function windowEvidence(overrides = {}) {
  return {
    schemaVersion: 1,
    city: 'Taipei',
    windowId,
    completedAt: '2026-07-19T19:29:00.000Z',
    result: 'unchanged',
    lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
    lastPublishedAt: '2026-07-12T19:27:00.000Z',
    activeVersion: 'v1',
    previousVersion: 'v0',
    failureClass: 'none',
    ...overrides,
  }
}

function probeEvidence(overrides = {}) {
  return {
    probeSchemaVersion: 1,
    city: 'Taipei',
    windowId,
    activeVersion: 'v1',
    previousVersion: 'v0',
    activeProbeAt: '2026-07-19T19:26:00.000Z',
    activeProbeResult: 'success',
    probeFailureClass: 'none',
    rollbackAvailable: true,
    ...overrides,
  }
}

function evaluate(overrides = {}) {
  return evaluateWindowWatchdog({
    city: 'Taipei',
    scheduleDate: '2026-07-20',
    evaluatedAt,
    window: windowEvidence(),
    sameWindowProbe: probeEvidence(),
    latestUsableProbe: null,
    attemptSummary: { attemptCount: 1, incompleteAttemptCount: 0 },
    recordWriteFailure: false,
    ...overrides,
  })
}

describe('window watchdog status contract', () => {
  it('classifies published with same-window active evidence', () => {
    expect(evaluate({ window: windowEvidence({ result: 'published' }) })).toMatchObject({
      status: 'published', diagnosticClass: 'none', probeResult: 'success', signalAgeBucket: 'same_window',
    })
  })

  it('classifies unchanged with rollback available as healthy', () => {
    expect(evaluate()).toMatchObject({
      status: 'unchanged_healthy', rollbackAvailable: true, diagnosticClass: 'none',
    })
  })

  it('keeps current active usable when only rollback is degraded', () => {
    expect(evaluate({
      sameWindowProbe: probeEvidence({
        activeProbeResult: 'degraded', probeFailureClass: 'previous_unavailable', rollbackAvailable: false,
      }),
    })).toMatchObject({
      status: 'unchanged_rollback_degraded', diagnosticClass: 'rollback_unavailable', rollbackAvailable: false,
    })
  })

  it('uses one prior weekly probe for a failed window while it remains within eight days', () => {
    const previous = probeEvidence({
      windowId: 'v1:Taipei:2026-07-13:0317',
      activeProbeAt: '2026-07-12T19:26:00.000Z',
    })
    expect(evaluate({
      window: windowEvidence({ result: 'failed', failureClass: 'snapshot_source_fetch', lastSourceCheckAt: null }),
      sameWindowProbe: null,
      latestUsableProbe: previous,
    })).toMatchObject({
      status: 'failed_active_healthy', diagnosticClass: 'window_failed_active_healthy',
      signalAgeBucket: '7_8d', probeWindowDistance: 1,
    })
  })

  it('classifies a failed window with a same-window hard probe failure as active unhealthy', () => {
    expect(evaluate({
      window: windowEvidence({ result: 'failed', failureClass: 'network_missing' }),
      sameWindowProbe: probeEvidence({
        activeProbeResult: 'error', probeFailureClass: 'network_missing', rollbackAvailable: false,
      }),
    })).toMatchObject({ status: 'failed_active_unhealthy', diagnosticClass: 'active_probe_failed' })
  })

  it('derives missing only after no terminal exists and preserves incomplete-attempt diagnosis', () => {
    expect(evaluate({ window: null, sameWindowProbe: null })).toMatchObject({
      status: 'missing', diagnosticClass: 'window_terminal_missing', windowResult: null,
    })
    expect(evaluate({
      window: null,
      sameWindowProbe: null,
      attemptSummary: { attemptCount: 1, incompleteAttemptCount: 1 },
    })).toMatchObject({ status: 'missing', diagnosticClass: 'attempt_incomplete' })
  })

  it('does not attach historical probe health for a different current active version', () => {
    expect(evaluate({
      window: null,
      sameWindowProbe: null,
      currentActiveVersion: 'v2',
      latestUsableProbe: probeEvidence({ windowId: 'v1:Taipei:2026-07-13:0317', activeVersion: 'v1' }),
    })).toMatchObject({ status: 'missing', probeResult: 'missing', rollbackAvailable: null })
  })

  it('does not reuse old green evidence when durable record writing failed', () => {
    expect(evaluate({
      window: null,
      sameWindowProbe: null,
      latestUsableProbe: probeEvidence({ windowId: 'v1:Taipei:2026-07-13:0317' }),
      recordWriteFailure: true,
    })).toMatchObject({ status: 'record_write_failed', diagnosticClass: 'record_write_failed' })
  })

  it('expires prior probe evidence after the conservative eight-day limit', () => {
    const oldAt = new Date(Date.parse(evaluatedAt) - WATCHDOG_MAX_PROBE_AGE_MS - 1).toISOString()
    expect(evaluate({
      window: windowEvidence({ result: 'failed', failureClass: 'snapshot_source_fetch' }),
      sameWindowProbe: null,
      latestUsableProbe: probeEvidence({
        windowId: 'v1:Taipei:2026-07-13:0317', activeProbeAt: oldAt,
      }),
    })).toMatchObject({ status: 'unknown', diagnosticClass: 'probe_evidence_expired' })
  })

  it('does not label chronologically expired evidence as same-window freshness', () => {
    const oldAt = new Date(Date.parse(evaluatedAt) - WATCHDOG_MAX_PROBE_AGE_MS - 1).toISOString()
    expect(evaluate({
      window: windowEvidence({ result: 'failed', failureClass: 'snapshot_source_fetch' }),
      sameWindowProbe: probeEvidence({ activeProbeAt: oldAt }),
    })).toMatchObject({
      status: 'unknown', diagnosticClass: 'probe_evidence_expired', signalAgeBucket: 'expired',
    })
  })

  it('fails closed on unsupported schemas and active-version conflicts', () => {
    expect(evaluate({ window: windowEvidence({ schemaVersion: 2 }) })).toMatchObject({
      status: 'unknown', diagnosticClass: 'unsupported_schema',
    })
    expect(evaluate({ sameWindowProbe: probeEvidence({ activeVersion: 'different' }) })).toMatchObject({
      status: 'unknown', diagnosticClass: 'active_version_conflict',
    })
  })

  it('does not accept an unchanged source check from outside the expected window', () => {
    expect(evaluate({
      window: windowEvidence({ lastSourceCheckAt: '2026-07-19T18:00:00.000Z' }),
    })).toMatchObject({ status: 'unknown', diagnosticClass: 'window_probe_conflict' })
  })

  it('creates exactly one strict privacy-safe city completion event', () => {
    const event = createWindowWatchdogEvent(evaluate(), '0123456789abcdef0123456789abcdef01234567')
    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      event: 'window_watchdog_completed', result: 'success', trafficClass: 'synthetic', sampleProbability: 1,
    })
    expect(JSON.stringify(event)).not.toMatch(/route|place|artifact|https?:|authorization|token|stack|message/i)
  })
})
