import { describe, expect, it } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import {
  createSnapshotWindowEvent,
  createSnapshotProbeEvent,
  parsePublisherMarker,
  safeWindowSummary,
  snapshotAttemptId,
  snapshotFailureClass,
  snapshotProgressMarker,
  snapshotProbeMarker,
  snapshotTerminalMarker,
  snapshotWindowIdentity,
  validateWindowOutcome,
} from './window-contract.mjs'

const healthyProbe = (overrides = {}) => ({
  probeSchemaVersion: 1,
  city: 'Taipei',
  windowId: 'v1:Taipei:2026-07-20:0317',
  activeVersion: '20260719T192700000Z',
  previousVersion: '20260712T192700000Z',
  activeProbeAt: '2026-07-19T19:26:00.000Z',
  activeProbeResult: 'success',
  probeFailureClass: 'none',
  rollbackAvailable: true,
  probeCaseVersion: 1,
  sampleCaseId: 'case_0123456789ab',
  hardChecksPassed: 11,
  diagnosticWarnings: [],
  latencyBucket: '1_3s',
  ...overrides,
})

const publishedOutcome = (overrides = {}) => {
  const value = {
    city: 'Taipei',
    windowId: 'v1:Taipei:2026-07-20:0317',
    attemptId: 'gh:29500000000:1:Taipei',
    scheduledAt: '2026-07-19T19:17:00.000Z',
    startedAt: '2026-07-19T19:18:00.000Z',
    completedAt: '2026-07-19T19:28:00.000Z',
    result: 'published',
    lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
    lastPublishedAt: '2026-07-19T19:27:00.000Z',
    activeVersion: '20260719T192700000Z',
    previousVersion: '20260712T192700000Z',
    workflowRunId: '29500000000',
    workflowRunAttempt: 1,
    scriptGitSha: '0123456789abcdef0123456789abcdef01234567',
    failureClass: 'none',
    runKind: 'scheduled',
    forcePublish: false,
    ...overrides,
  }
  if ((value.result === 'published' || value.result === 'unchanged') && !Object.hasOwn(overrides, 'probe')) {
    value.probe = healthyProbe({ activeVersion: value.activeVersion, previousVersion: value.previousVersion })
  }
  return validateWindowOutcome(value)
}

describe('snapshot window contract', () => {
  it('derives the deterministic Asia/Taipei scheduled slot independently of workflow run ID', () => {
    const first = snapshotWindowIdentity({ city: 'Taipei', now: new Date('2026-07-19T19:18:00.000Z') })
    const later = snapshotWindowIdentity({ city: 'Taipei', now: new Date('2026-07-20T12:00:00.000Z') })
    expect(first).toEqual({
      windowId: 'v1:Taipei:2026-07-20:0317',
      scheduledAt: '2026-07-19T19:17:00.000Z',
      runKind: 'scheduled',
    })
    expect(later).toEqual(first)
  })

  it('uses the previous weekly slot before a city schedule and supports explicit manual windows', () => {
    expect(snapshotWindowIdentity({ city: 'Taipei', now: new Date('2026-07-19T19:16:00.000Z') }).windowId)
      .toBe('v1:Taipei:2026-07-13:0317')
    expect(snapshotWindowIdentity({
      city: 'Chiayi',
      now: new Date('2026-07-20T10:00:00.000Z'),
    }).windowId).toBe('v1:Chiayi:2026-07-14:0317')
    expect(snapshotWindowIdentity({
      city: 'Chiayi',
      now: new Date('2026-07-20T10:00:00.000Z'),
      windowType: 'manual',
      windowDate: '2026-07-18',
    })).toEqual({
      windowId: 'v1:Chiayi:2026-07-18:manual',
      scheduledAt: '2026-07-17T16:00:00.000Z',
      runKind: 'manual',
    })
  })

  it('keeps rerun attempt identity stable and separates GitHub run attempts', () => {
    const base = { city: 'Taipei', workflowRunId: '29500000000', startedAt: '2026-07-19T19:18:00.000Z' }
    expect(snapshotAttemptId({ ...base, workflowRunAttempt: 1 })).toBe('gh:29500000000:1:Taipei')
    expect(snapshotAttemptId({ ...base, workflowRunAttempt: 2 })).toBe('gh:29500000000:2:Taipei')
  })

  it('accepts only strict progress and successful publisher terminal markers', () => {
    const progress = snapshotProgressMarker('Taipei', 'stage', {
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
      previousVersion: 'v1',
    }, new Date('2026-07-19T19:21:00.000Z'))
    expect(parsePublisherMarker(progress, 'Taipei')).toEqual(progress)
    expect(progress.lastPublishedAt).toBe('2026-07-12T19:27:00.000Z')
    expect(snapshotTerminalMarker('Taipei', 'unchanged', {
      activeVersion: 'v1',
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
    })).toMatchObject({ result: 'unchanged', activeVersion: 'v1' })
    expect(parsePublisherMarker({ ...progress, url: 'https://private.example/query' }, 'Taipei')).toEqual(progress)
    expect(parsePublisherMarker({ ...progress, phase: 'arbitrary' }, 'Taipei')).toBeUndefined()
    const probe = snapshotProbeMarker(healthyProbe())
    expect(parsePublisherMarker(probe, 'Taipei')).toEqual(probe)
  })

  it('maps fixed failure classes without preserving raw errors', () => {
    expect(snapshotFailureClass('source_fetch')).toBe('snapshot_source_fetch')
    expect(snapshotFailureClass('remote_validation')).toBe('snapshot_remote_validation')
    expect(snapshotFailureClass('raw https://private.example')).toBe('unknown')
  })

  it('creates an A1-compatible, privacy-safe window completion event', () => {
    const event = createSnapshotWindowEvent(publishedOutcome(), '0123456789abcdef0123456789abcdef01234567')
    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      event: 'snapshot_window_completed',
      result: 'success',
      windowResult: 'published',
      trafficClass: 'snapshot_publish',
      sampleProbability: 1,
    })
    expect(JSON.stringify(event)).not.toMatch(/token|authorization|route|stop|https?:|stack|message/i)
  })

  it('keeps unchanged source-check and published time independent', () => {
    const outcome = publishedOutcome({
      result: 'unchanged',
      completedAt: '2026-07-26T19:22:00.000Z',
      lastSourceCheckAt: '2026-07-26T19:21:00.000Z',
      lastPublishedAt: '2026-07-19T19:27:00.000Z',
      probe: healthyProbe(),
    })
    expect(outcome.lastSourceCheckAt).toBe('2026-07-26T19:21:00.000Z')
    expect(outcome.lastPublishedAt).toBe('2026-07-19T19:27:00.000Z')
    expect(safeWindowSummary(outcome, 'success')).toMatchObject({ result: 'unchanged' })
  })

  it('does not accept unchanged without matching non-error probe evidence', () => {
    expect(() => publishedOutcome({ probe: null })).toThrow()
    expect(() => publishedOutcome({ result: 'unchanged', probe: null })).toThrow()
    expect(() => publishedOutcome({
      result: 'unchanged',
      probe: healthyProbe({ activeProbeResult: 'error', probeFailureClass: 'network_missing', rollbackAvailable: false }),
    })).toThrow()
    expect(() => publishedOutcome({
      result: 'unchanged',
      probe: healthyProbe({ windowId: 'v1:Taipei:2026-07-27:0317' }),
    })).toThrow()
    expect(() => publishedOutcome({
      result: 'unchanged',
      probe: healthyProbe({ activeVersion: 'different-version' }),
    })).toThrow()
  })

  it('keeps a hard probe failure attached to the matching failed window', () => {
    const outcome = publishedOutcome({
      result: 'failed',
      failureClass: 'network_missing',
      probe: healthyProbe({
        activeProbeResult: 'error', probeFailureClass: 'network_missing', rollbackAvailable: false,
        hardChecksPassed: 5,
      }),
    })
    expect(outcome).toMatchObject({ result: 'failed', failureClass: 'network_missing' })
    expect(outcome.probe).toMatchObject({ activeProbeResult: 'error', probeFailureClass: 'network_missing' })
  })

  it('creates one authoritative probe event without artifact identity', () => {
    const event = createSnapshotProbeEvent(healthyProbe(), '0123456789abcdef0123456789abcdef01234567')
    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      event: 'snapshot_probe_completed', result: 'success', operation: 'snapshot_probe',
      trafficClass: 'publish_smoke', versionRole: 'active', hardChecksPassed: 11,
    })
    expect(JSON.stringify(event)).not.toMatch(/routeUid|placeId|stopUid|artifact|https?:|stack|message/i)
  })

  it('requires a failure class only for failed terminal outcomes', () => {
    expect(() => publishedOutcome({ result: 'failed', failureClass: 'none' })).toThrow()
    expect(() => publishedOutcome({ result: 'published', failureClass: 'snapshot_stage' })).toThrow()
    expect(publishedOutcome({
      result: 'failed',
      failureClass: 'snapshot_source_fetch',
      lastSourceCheckAt: null,
    })).toMatchObject({ result: 'failed', lastSourceCheckAt: null })
  })
})
