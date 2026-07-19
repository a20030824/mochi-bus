import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validateWindowOutcome } from './window-contract.mjs'
import { createD1WindowStore, queryD1 } from './window-d1.mjs'

const migration = [
  readFileSync(new URL('../../migrations/0003_snapshot_window_outcomes.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../../migrations/0004_snapshot_active_probes.sql', import.meta.url), 'utf8'),
  readFileSync(new URL('../../migrations/0005_snapshot_window_watchdog.sql', import.meta.url), 'utf8'),
].join('\n')

function healthyProbe(overrides = {}) {
  return {
    probeSchemaVersion: 1,
    city: 'Taipei',
    windowId: 'v1:Taipei:2026-07-20:0317',
    activeVersion: 'v1',
    previousVersion: null,
    activeProbeAt: '2026-07-19T19:26:00.000Z',
    activeProbeResult: 'success',
    probeFailureClass: 'none',
    rollbackAvailable: false,
    probeCaseVersion: 1,
    sampleCaseId: 'case_0123456789ab',
    hardChecksPassed: 11,
    diagnosticWarnings: [],
    latencyBucket: '1_3s',
    ...overrides,
  }
}

function outcome(overrides = {}) {
  const value = {
    city: 'Taipei',
    windowId: 'v1:Taipei:2026-07-20:0317',
    attemptId: 'gh:100:1:Taipei',
    scheduledAt: '2026-07-19T19:17:00.000Z',
    startedAt: '2026-07-19T19:18:00.000Z',
    completedAt: '2026-07-19T19:28:00.000Z',
    result: 'failed',
    lastSourceCheckAt: null,
    lastPublishedAt: '2026-07-12T19:27:00.000Z',
    activeVersion: 'v1',
    previousVersion: null,
    workflowRunId: '100',
    workflowRunAttempt: 1,
    scriptGitSha: '0123456789abcdef0123456789abcdef01234567',
    failureClass: 'snapshot_source_fetch',
    runKind: 'scheduled',
    forcePublish: false,
    ...overrides,
  }
  if ((value.result === 'published' || value.result === 'unchanged') && !Object.hasOwn(overrides, 'probe')) {
    value.probe = healthyProbe({ activeVersion: value.activeVersion, previousVersion: value.previousVersion })
  }
  return validateWindowOutcome(value)
}

describe('snapshot window D1 store', () => {
  let db
  let fetchImpl
  let store

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(migration)
    // The migration is intentionally safe to apply again outside Wrangler migration tracking.
    db.exec(migration)
    db.exec("CREATE TABLE dataset_versions (city_code TEXT PRIMARY KEY, active_version TEXT NOT NULL, imported_at TEXT NOT NULL)")
    db.exec("INSERT INTO dataset_versions VALUES ('Taipei', 'v1', '2026-07-12T19:27:00.000Z')")
    fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body)
      const queries = Array.isArray(body) ? body : [body]
      const result = []
      db.exec('BEGIN')
      try {
        for (const { sql, params } of queries) {
          const statement = db.prepare(sql)
          const results = /^\s*SELECT/i.test(sql) ? statement.all(...params) : (statement.run(...params), [])
          result.push({ success: true, results })
        }
        db.exec('COMMIT')
      } catch (error) {
        db.exec('ROLLBACK')
        throw error
      }
      return Response.json({ success: true, result })
    })
    store = createD1WindowStore({ accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl })
  })

  afterEach(() => {
    db.close()
    vi.restoreAllMocks()
  })

  it('records an idempotent attempt start and resolves GitHub reruns to the same window', async () => {
    const value = outcome()
    await store.recordStart(value)
    await store.recordStart(value)
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_window_attempts').get().count).toBe(1)
    await expect(store.findWindowForWorkflowRun('Taipei', '100')).resolves.toEqual({
      windowId: value.windowId,
      scheduledAt: value.scheduledAt,
      runKind: 'scheduled',
    })
  })

  it('records a fixed durable-write failure marker without snapshot mutation', async () => {
    const value = outcome()
    await store.recordStart(value)
    await store.recordWriteFailure({
      city: value.city,
      windowId: value.windowId,
      attemptId: value.attemptId,
      recordedAt: '2026-07-19T19:29:00.000Z',
    })
    await store.recordWriteFailure({
      city: value.city,
      windowId: value.windowId,
      attemptId: value.attemptId,
      recordedAt: '2026-07-19T19:29:00.000Z',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_window_record_failures').get().count).toBe(1)
    expect(db.prepare('SELECT active_version FROM dataset_versions WHERE city_code = ?').get('Taipei').active_version)
      .toBe('v1')
  })

  it('stores unchanged as terminal while preserving the previous publication time', async () => {
    const value = outcome({
      result: 'unchanged',
      failureClass: 'none',
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
      probe: healthyProbe(),
    })
    await store.complete(value)
    const row = db.prepare('SELECT * FROM snapshot_windows').get()
    expect(row).toMatchObject({
      result: 'unchanged',
      last_source_check_at: '2026-07-19T19:20:00.000Z',
      last_published_at: '2026-07-12T19:27:00.000Z',
      active_version: 'v1',
    })
    expect(db.prepare('SELECT * FROM snapshot_active_probes').get()).toMatchObject({
      active_probe_result: 'success',
      active_version: 'v1',
      hard_checks_passed: 11,
      diagnostic_warnings: '[]',
    })
  })

  it('preserves a successful canonical probe while retaining a newer failed attempt', async () => {
    await store.complete(outcome({
      result: 'unchanged', failureClass: 'none',
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z', probe: healthyProbe(),
    }))
    await store.complete(outcome({
      attemptId: 'gh:101:1:Taipei', workflowRunId: '101',
      startedAt: '2026-07-19T19:30:00.000Z', completedAt: '2026-07-19T19:31:00.000Z',
      result: 'failed', failureClass: 'network_missing',
      lastSourceCheckAt: '2026-07-19T19:30:30.000Z',
      probe: healthyProbe({
        activeProbeAt: '2026-07-19T19:30:45.000Z', activeProbeResult: 'error',
        probeFailureClass: 'network_missing', rollbackAvailable: false, hardChecksPassed: 5,
      }),
    }))
    expect(db.prepare('SELECT active_probe_result, attempt_id FROM snapshot_active_probes').get())
      .toEqual({ active_probe_result: 'success', attempt_id: 'gh:100:1:Taipei' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_probe_attempts').get().count).toBe(2)
  })

  it('does not leave an unchanged canonical window when the atomic probe record batch fails', async () => {
    const baseFetch = fetchImpl
    const failingBatchFetch = vi.fn(async (url, init) => {
      if (Array.isArray(JSON.parse(init.body))) {
        return Response.json({ success: false, result: [] }, { status: 500 })
      }
      return baseFetch(url, init)
    })
    const atomicStore = createD1WindowStore({
      accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl: failingBatchFetch,
    })
    const value = outcome({
      result: 'unchanged', failureClass: 'none',
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z', probe: healthyProbe(),
    })
    await atomicStore.recordStart(value)
    await expect(atomicStore.complete(value)).rejects.toThrow('D1 window query failed')
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_windows').get().count).toBe(0)
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_active_probes').get().count).toBe(0)
    expect(db.prepare('SELECT result FROM snapshot_window_attempts').get().result).toBeNull()

    await store.complete(value)
    expect(db.prepare('SELECT result FROM snapshot_windows').get().result).toBe('unchanged')
    expect(db.prepare('SELECT active_probe_result FROM snapshot_active_probes').get().active_probe_result).toBe('success')
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_window_attempts').get().count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_probe_attempts').get().count).toBe(1)
  })

  it('does not let an older workflow completion overwrite a newer successful probe', async () => {
    await store.complete(outcome({
      attemptId: 'gh:102:1:Taipei', workflowRunId: '102',
      startedAt: '2026-07-19T19:30:00.000Z', completedAt: '2026-07-19T19:31:00.000Z',
      result: 'unchanged', failureClass: 'none',
      probe: healthyProbe({ activeProbeAt: '2026-07-19T19:30:45.000Z' }),
    }))
    await store.complete(outcome({
      attemptId: 'gh:101:1:Taipei', workflowRunId: '101',
      startedAt: '2026-07-19T19:00:00.000Z', completedAt: '2026-07-19T19:40:00.000Z',
      result: 'failed', failureClass: 'network_missing',
      probe: healthyProbe({
        activeProbeAt: '2026-07-19T19:39:00.000Z', activeProbeResult: 'error',
        probeFailureClass: 'network_missing', rollbackAvailable: false, hardChecksPassed: 5,
      }),
    }))

    expect(db.prepare('SELECT active_probe_result, attempt_id FROM snapshot_active_probes').get())
      .toEqual({ active_probe_result: 'success', attempt_id: 'gh:102:1:Taipei' })
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_probe_attempts').get().count).toBe(2)
  })

  it('lets a newer failed attempt become published and updates both freshness timestamps', async () => {
    await store.complete(outcome())
    await store.complete(outcome({
      attemptId: 'gh:101:1:Taipei',
      workflowRunId: '101',
      startedAt: '2026-07-19T19:30:00.000Z',
      completedAt: '2026-07-19T19:40:00.000Z',
      result: 'published',
      failureClass: 'none',
      lastSourceCheckAt: '2026-07-19T19:32:00.000Z',
      lastPublishedAt: '2026-07-19T19:39:00.000Z',
      activeVersion: 'v2',
      previousVersion: 'v1',
    }))
    expect(db.prepare('SELECT * FROM snapshot_windows').get()).toMatchObject({
      result: 'published',
      active_version: 'v2',
      previous_version: 'v1',
      last_source_check_at: '2026-07-19T19:32:00.000Z',
      last_published_at: '2026-07-19T19:39:00.000Z',
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_window_attempts').get().count).toBe(2)
  })

  it('does not let an older or lower-ranked attempt overwrite a successful canonical terminal', async () => {
    await store.complete(outcome({
      attemptId: 'gh:200:1:Taipei',
      workflowRunId: '200',
      startedAt: '2026-07-19T19:30:00.000Z',
      completedAt: '2026-07-19T19:40:00.000Z',
      result: 'published',
      failureClass: 'none',
      lastSourceCheckAt: '2026-07-19T19:32:00.000Z',
      lastPublishedAt: '2026-07-19T19:39:00.000Z',
      activeVersion: 'v2',
      previousVersion: 'v1',
    }))
    await store.complete(outcome())
    await store.complete(outcome({
      attemptId: 'gh:201:1:Taipei',
      workflowRunId: '201',
      startedAt: '2026-07-19T19:50:00.000Z',
      completedAt: '2026-07-19T19:55:00.000Z',
    }))
    expect(db.prepare('SELECT result, active_version, workflow_run_id FROM snapshot_windows').get())
      .toEqual({ result: 'published', active_version: 'v2', workflow_run_id: '200' })
  })

  it('reads the actual D1 active pointer instead of an expected publication version', async () => {
    await expect(store.readActiveSnapshot('Taipei')).resolves.toEqual({
      activeVersion: 'v1',
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
    })
  })

  it('uses bound REST parameters and never includes the API token in SQL or request body', async () => {
    await store.readActiveSnapshot('Taipei')
    const [, init] = fetchImpl.mock.calls[0]
    expect(init.headers.Authorization).toBe('Bearer private-token')
    expect(init.body).not.toContain('private-token')
    expect(JSON.parse(init.body)).toMatchObject({ params: ['Taipei'] })
  })

  it('returns a fixed error instead of exposing D1 response bodies', async () => {
    const failingFetch = vi.fn(async () => new Response(JSON.stringify({
      success: false,
      errors: [{ message: 'private upstream detail https://example.test?q=secret' }],
    }), { status: 500 }))
    await expect(queryD1({
      accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl: failingFetch,
      sql: 'SELECT 1', params: [],
    })).rejects.toThrow('D1 window query failed')
    await expect(queryD1({
      accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl: failingFetch,
      sql: 'SELECT 1', params: [],
    })).rejects.not.toThrow(/private|https|secret/)
  })
})
