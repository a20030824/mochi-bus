import { describe, expect, it } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import {
  createSnapshotWindowEvent,
  parsePublisherMarker,
  safeWindowSummary,
  snapshotAttemptId,
  snapshotFailureClass,
  snapshotProgressMarker,
  snapshotTerminalMarker,
  snapshotWindowIdentity,
  validateWindowOutcome,
} from './window-contract.mjs'

const publishedOutcome = (overrides = {}) => validateWindowOutcome({
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
})

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
    })
    expect(outcome.lastSourceCheckAt).toBe('2026-07-26T19:21:00.000Z')
    expect(outcome.lastPublishedAt).toBe('2026-07-19T19:27:00.000Z')
    expect(safeWindowSummary(outcome, 'success')).toMatchObject({ result: 'unchanged' })
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
