import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runSnapshotWindow } from './run-snapshot-window.mjs'

const sourceCheckedAt = '2026-07-19T19:20:00.000Z'

function healthyProbe(overrides = {}) {
  return {
    probeSchemaVersion: 1,
    city: 'Taipei',
    windowId: 'v1:Taipei:2026-07-20:0317',
    activeVersion: 'v1',
    previousVersion: 'v0',
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
  }
}

function environment(overrides = {}) {
  return {
    GITHUB_RUN_ID: '29500000000',
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_SHA: '0123456789abcdef0123456789abcdef01234567',
    ...overrides,
  }
}

function fakeStore(overrides = {}) {
  return {
    findWindowForWorkflowRun: vi.fn(async () => null),
    recordStart: vi.fn(async () => undefined),
    readActiveSnapshot: vi.fn(async () => ({
      activeVersion: 'v1',
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
    })),
    complete: vi.fn(async () => undefined),
    ...overrides,
  }
}

function clock(start = '2026-07-19T19:18:00.000Z', end = '2026-07-19T19:28:00.000Z') {
  return vi.fn()
    .mockReturnValueOnce(new Date(start))
    .mockReturnValueOnce(new Date(end))
}

function terminal(result, overrides = {}) {
  return {
    exitCode: 0,
    lastPhase: result === 'published' ? 'finalize' : 'source_compare',
    lastSourceCheckAt: sourceCheckedAt,
    previousVersion: 'v0',
    terminal: {
      event: 'snapshot_window_terminal',
      city: 'Taipei',
      result,
      at: '2026-07-19T19:27:00.000Z',
      lastSourceCheckAt: sourceCheckedAt,
      activeVersion: result === 'published' ? 'v2' : 'v1',
      previousVersion: 'v0',
    },
    probe: result === 'unchanged' ? healthyProbe() : null,
    ...overrides,
  }
}

describe('snapshot window runner', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => vi.restoreAllMocks())

  it('records unchanged with a fresh source-check time but preserves D1 publication time', async () => {
    const store = fakeStore()
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('unchanged'),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.ok).toBe(true)
    expect(result.outcome).toMatchObject({
      result: 'unchanged',
      lastSourceCheckAt: sourceCheckedAt,
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
      activeVersion: 'v1',
    })
    expect(store.complete).toHaveBeenCalledWith(result.outcome)
  })

  it('records published from the actual post-publication D1 pointer', async () => {
    const store = fakeStore({
      readActiveSnapshot: vi.fn(async () => ({
        activeVersion: 'v2',
        lastPublishedAt: '2026-07-19T19:27:00.000Z',
      })),
    })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('published'),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      result: 'published', activeVersion: 'v2', previousVersion: 'v0', failureClass: 'none',
      lastSourceCheckAt: sourceCheckedAt, lastPublishedAt: '2026-07-19T19:27:00.000Z',
    })
  })

  it('does not claim a source check when acquisition fails before the marker', async () => {
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store: fakeStore(),
      publisher: async () => ({ exitCode: 1, lastPhase: 'source_fetch', lastSourceCheckAt: null, terminal: null }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.outcome).toMatchObject({
      result: 'failed', failureClass: 'snapshot_source_fetch', lastSourceCheckAt: null, activeVersion: 'v1',
    })
  })

  it('records the actual new active pointer when finalize fails after activation', async () => {
    const store = fakeStore({
      readActiveSnapshot: vi.fn(async () => ({
        activeVersion: 'v2', lastPublishedAt: '2026-07-19T19:25:00.000Z',
      })),
    })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => ({
        exitCode: 1, lastPhase: 'finalize', lastSourceCheckAt: sourceCheckedAt,
        previousVersion: 'v1', terminal: null,
      }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      result: 'failed', failureClass: 'snapshot_finalize', activeVersion: 'v2', previousVersion: 'v1',
      lastPublishedAt: '2026-07-19T19:25:00.000Z',
    })
  })

  it('does not mistake a smoke rollback timestamp for a successful publication time', async () => {
    const store = fakeStore({
      readActiveSnapshot: vi.fn(async () => ({
        activeVersion: 'v1',
        // Rollback updates dataset_versions.imported_at, but it is not a new publication.
        lastPublishedAt: '2026-07-19T19:26:00.000Z',
      })),
    })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => ({
        exitCode: 1,
        lastPhase: 'smoke',
        lastSourceCheckAt: sourceCheckedAt,
        lastPublishedAt: '2026-07-12T19:27:00.000Z',
        previousVersion: 'v1',
        terminal: null,
      }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      result: 'failed',
      failureClass: 'snapshot_smoke',
      activeVersion: 'v1',
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
    })
  })

  it('fails an unchanged window when the active probe fails without changing publication time', async () => {
    const store = fakeStore()
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => ({
        exitCode: 1,
        lastPhase: 'source_compare',
        lastSourceCheckAt: sourceCheckedAt,
        lastPublishedAt: '2026-07-12T19:27:00.000Z',
        previousVersion: 'v0',
        terminal: null,
        probe: healthyProbe({
          activeProbeResult: 'error', probeFailureClass: 'network_missing',
          rollbackAvailable: false, hardChecksPassed: 5,
        }),
      }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      result: 'failed', failureClass: 'network_missing', activeVersion: 'v1',
      lastSourceCheckAt: sourceCheckedAt, lastPublishedAt: '2026-07-12T19:27:00.000Z',
    })
    expect(result.outcome.probe).toMatchObject({ activeProbeResult: 'error', hardChecksPassed: 5 })
    expect(store.complete).toHaveBeenCalledWith(result.outcome)
  })

  it('fails closed when an unchanged terminal marker has no probe evidence', async () => {
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store: fakeStore(),
      publisher: async () => terminal('unchanged', { probe: null }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.ok).toBe(false)
    expect(result.outcome).toMatchObject({
      result: 'failed', failureClass: 'snapshot_source_compare', activeVersion: 'v1', probe: null,
    })
  })

  it('keeps active usable when only rollback capability is degraded', async () => {
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store: fakeStore(),
      publisher: async () => terminal('unchanged', {
        probe: healthyProbe({
          activeProbeResult: 'degraded', probeFailureClass: 'previous_unavailable',
          rollbackAvailable: false, diagnosticWarnings: ['previous_unavailable'],
        }),
      }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.ok).toBe(true)
    expect(result.outcome).toMatchObject({ result: 'unchanged', failureClass: 'none' })
    expect(result.summary).toMatchObject({ activeProbeResult: 'degraded', rollbackAvailable: false })
  })

  it('reuses the original workflow window on a GitHub rerun', async () => {
    const store = fakeStore({
      findWindowForWorkflowRun: vi.fn(async () => ({
        windowId: 'v1:Taipei:2026-07-13:0317',
        scheduledAt: '2026-07-12T19:17:00.000Z',
        runKind: 'scheduled',
      })),
    })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment({ GITHUB_RUN_ATTEMPT: '2' }), now: clock(), store,
      publisher: async () => terminal('unchanged', { probe: healthyProbe({ windowId: 'v1:Taipei:2026-07-13:0317' }) }),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      windowId: 'v1:Taipei:2026-07-13:0317',
      attemptId: 'gh:29500000000:2:Taipei',
      workflowRunAttempt: 2,
    })
  })

  it('keeps manual force publish in the selected manual window', async () => {
    const result = await runSnapshotWindow({
      city: 'Taipei',
      env: environment({ SNAPSHOT_WINDOW_TYPE: 'manual', SNAPSHOT_WINDOW_DATE: '2026-07-18', SNAPSHOT_FORCE: '1' }),
      now: clock(), store: fakeStore(), publisher: async () => terminal('published'),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.outcome).toMatchObject({
      windowId: 'v1:Taipei:2026-07-18:manual', runKind: 'manual', forcePublish: true,
    })
  })

  it('does not undo a successful publication when durable state writing fails', async () => {
    const productPublication = vi.fn(async () => terminal('published'))
    const store = fakeStore({ complete: vi.fn(async () => { throw new Error('D1 unavailable') }) })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: productPublication, emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(productPublication).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ ok: false, durableRecordWrite: 'failed' })
    expect(result.outcome.result).toBe('published')
  })

  it('does not touch the active snapshot when durable probe evidence cannot be written', async () => {
    const store = fakeStore({ complete: vi.fn(async () => { throw new Error('probe table unavailable') }) })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('unchanged'),
      emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result).toMatchObject({ ok: false, durableRecordWrite: 'failed' })
    expect(result.outcome).toMatchObject({ result: 'unchanged', activeVersion: 'v1' })
    expect(store.readActiveSnapshot).toHaveBeenCalledOnce()
  })

  it('recovers from a start-record failure when terminal upsert succeeds', async () => {
    const store = fakeStore({ recordStart: vi.fn(async () => { throw new Error('temporary') }) })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('unchanged'), emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result).toMatchObject({ ok: true, startRecordWrite: 'failed', durableRecordWrite: 'success' })
  })

  it('fails closed on active-pointer uncertainty without exposing the raw database error', async () => {
    const store = fakeStore({ readActiveSnapshot: vi.fn(async () => { throw new Error('private D1 detail') }) })
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('unchanged'), emitter: vi.fn(), summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(store.readActiveSnapshot).toHaveBeenCalledTimes(3)
    expect(result.outcome).toMatchObject({
      result: 'failed', failureClass: 'active_pointer_invalid', activeVersion: null,
    })
  })

  it('keeps snapshot outcome and response independent when the event emitter throws', async () => {
    const store = fakeStore()
    const result = await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store,
      publisher: async () => terminal('unchanged'),
      emitter: () => { throw new Error('logs unavailable') },
      summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(result.ok).toBe(true)
    expect(store.complete).toHaveBeenCalledOnce()
  })

  it('emits only allowlisted window metadata', async () => {
    const events = []
    await runSnapshotWindow({
      city: 'Taipei', env: environment(), now: clock(), store: fakeStore(),
      publisher: async () => terminal('unchanged'), emitter: (event) => events.push(event),
      summaryWriter: vi.fn(), activeReadRetryDelayMs: 0,
    })
    expect(events).toHaveLength(2)
    expect(events.map((event) => event.event)).toEqual(['snapshot_window_completed', 'snapshot_probe_completed'])
    expect(JSON.stringify(events)).not.toMatch(/token|authorization|https?:|routeUid|stopUid|stack|message/i)
  })
})
