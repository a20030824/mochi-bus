import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createD1WatchdogStore, watchdogRunId } from './watchdog-d1.mjs'
import { evaluateWindowWatchdog } from './watchdog-contract.mjs'

const migration = [3, 4, 5].map((number) => readFileSync(new URL(
  `../../migrations/${String(number).padStart(4, '0')}_${number === 3 ? 'snapshot_window_outcomes' : number === 4 ? 'snapshot_active_probes' : 'snapshot_window_watchdog'}.sql`,
  import.meta.url,
), 'utf8')).join('\n')

describe('snapshot watchdog D1 store', () => {
  let db
  let store

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(migration)
    db.exec(migration)
    db.exec('CREATE TABLE dataset_versions (city_code TEXT PRIMARY KEY, active_version TEXT NOT NULL)')
    db.exec("INSERT INTO dataset_versions VALUES ('Taipei', 'v1')")
    const fetchImpl = vi.fn(async (_url, init) => {
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
    store = createD1WatchdogStore({
      accountId: 'account', apiToken: 'private-token', databaseId: 'database', fetchImpl,
    })
  })

  afterEach(() => db.close())

  it('reads canonical window, attempt, probe and record-write evidence from D1', async () => {
    db.prepare(`INSERT INTO snapshot_window_attempts VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-1', '2026-07-19T19:17:00.000Z',
       '2026-07-19T19:18:00.000Z', NULL, NULL, NULL, NULL, NULL, NULL, '100', 1, NULL, 'none', 'scheduled', 0)`).run()
    db.prepare(`INSERT INTO snapshot_windows VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', '2026-07-19T19:17:00.000Z',
       '2026-07-19T19:18:00.000Z', '2026-07-19T19:29:00.000Z', 'unchanged',
       '2026-07-19T19:20:00.000Z', '2026-07-12T19:27:00.000Z', 'v1', 'v0', '100', 1, NULL,
       'none', 'scheduled', 0)`).run()
    db.prepare(`INSERT INTO snapshot_active_probes VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-1', '2026-07-19T19:18:00.000Z',
       'v1', 'v0', '2026-07-19T19:26:00.000Z', 'success', 'none', 1, 1, 'case_safe', 11, '[]')`).run()
    db.prepare(`INSERT INTO snapshot_window_record_failures VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-1', '2026-07-19T19:30:00.000Z', 'record_write_failed')`).run()

    await expect(store.readEvidence('Taipei', 'v1:Taipei:2026-07-20:0317')).resolves.toMatchObject({
      window: { schemaVersion: 1, result: 'unchanged', activeVersion: 'v1' },
      attemptSummary: { attemptCount: 1, incompleteAttemptCount: 1 },
      sameWindowProbe: { probeSchemaVersion: 1, activeProbeResult: 'success', rollbackAvailable: true },
      latestUsableProbe: { windowId: 'v1:Taipei:2026-07-20:0317' },
      recordWriteFailure: true,
      currentActiveVersion: 'v1',
    })
  })

  it('ignores an older write-failure marker after a later rerun durably completes the window', async () => {
    db.prepare(`INSERT INTO snapshot_window_record_failures VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-old', '2026-07-19T19:20:00.000Z', 'record_write_failed')`).run()
    db.prepare(`INSERT INTO snapshot_windows VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', '2026-07-19T19:17:00.000Z',
       '2026-07-19T19:25:00.000Z', '2026-07-19T19:29:00.000Z', 'published',
       '2026-07-19T19:21:00.000Z', '2026-07-19T19:25:00.000Z', 'v1', 'v0', '101', 2, NULL,
       'none', 'scheduled', 0)`).run()

    await expect(store.readEvidence('Taipei', 'v1:Taipei:2026-07-20:0317')).resolves.toMatchObject({
      window: { result: 'published' },
      recordWriteFailure: false,
    })
  })

  it('keeps a write-failure marker newer than the last durable canonical completion', async () => {
    db.prepare(`INSERT INTO snapshot_windows VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', '2026-07-19T19:17:00.000Z',
       '2026-07-19T19:20:00.000Z', '2026-07-19T19:29:00.000Z', 'unchanged',
       '2026-07-19T19:18:00.000Z', '2026-07-12T19:27:00.000Z', 'v1', 'v0', '100', 1, NULL,
       'none', 'scheduled', 0)`).run()
    db.prepare(`INSERT INTO snapshot_window_record_failures VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-late', '2026-07-19T19:30:00.000Z', 'record_write_failed')`).run()

    await expect(store.readEvidence('Taipei', 'v1:Taipei:2026-07-20:0317')).resolves.toMatchObject({
      window: { result: 'unchanged' },
      recordWriteFailure: true,
    })
  })

  it('selects historical probe evidence for the actual D1 active version', async () => {
    db.prepare(`INSERT INTO snapshot_active_probes VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-13:0317', 'attempt-current', '2026-07-12T19:18:00.000Z',
       'v1', 'v0', '2026-07-12T19:26:00.000Z', 'success', 'none', 1, 1, 'case_current', 11, '[]')`).run()
    db.prepare(`INSERT INTO snapshot_active_probes VALUES
      (1, 'Taipei', 'v1:Taipei:2026-07-20:0317', 'attempt-other', '2026-07-19T19:18:00.000Z',
       'v2', 'v1', '2026-07-19T19:26:00.000Z', 'success', 'none', 1, 1, 'case_other', 11, '[]')`).run()

    await expect(store.readEvidence('Taipei', 'v1:Taipei:2026-07-20:0317')).resolves.toMatchObject({
      latestUsableProbe: { windowId: 'v1:Taipei:2026-07-13:0317', activeVersion: 'v1' },
      currentActiveVersion: 'v1',
    })
  })

  it('keeps run/city writes idempotent and prevents an older run from replacing canonical status', async () => {
    const newer = evaluateWindowWatchdog({
      city: 'Taipei', scheduleDate: '2026-07-20', evaluatedAt: '2026-07-19T23:50:00.000Z',
      window: null, sameWindowProbe: null, latestUsableProbe: null,
    })
    const older = evaluateWindowWatchdog({
      city: 'Taipei', scheduleDate: '2026-07-20', evaluatedAt: '2026-07-19T23:45:00.000Z',
      window: null, sameWindowProbe: null, latestUsableProbe: null,
      attemptSummary: { attemptCount: 1, incompleteAttemptCount: 1 },
    })
    await store.startRun({ watchdogRunId: 'gh:200:1', evaluatedAt: newer.evaluatedAt, scheduleDate: newer.scheduleDate })
    await store.completeCity('gh:200:1', newer)
    await store.completeCity('gh:200:1', newer)
    await store.startRun({ watchdogRunId: 'gh:199:1', evaluatedAt: older.evaluatedAt, scheduleDate: older.scheduleDate })
    await store.completeCity('gh:199:1', older)
    await store.completeRun({
      watchdogRunId: 'gh:200:1', evaluatedAt: newer.evaluatedAt,
      completedAt: '2026-07-19T23:51:00.000Z', result: 'failed', failureCount: 1,
    })

    expect(db.prepare('SELECT COUNT(*) AS count FROM snapshot_watchdog_city_attempts').get().count).toBe(2)
    expect(db.prepare('SELECT watchdog_run_id, diagnostic_class FROM snapshot_watchdog_city_results').get())
      .toEqual({ watchdog_run_id: 'gh:200:1', diagnostic_class: 'window_terminal_missing' })
    expect(db.prepare('SELECT result, failure_count FROM snapshot_watchdog_runs WHERE watchdog_run_id = ?').get('gh:200:1'))
      .toEqual({ result: 'failed', failure_count: 1 })
  })

  it('uses stable GitHub identity and separates local runs', () => {
    expect(watchdogRunId({ workflowRunId: '200', workflowRunAttempt: 2, evaluatedAt: '2026-07-19T23:45:00.000Z' }))
      .toBe('gh:200:2')
    expect(watchdogRunId({ workflowRunId: null, evaluatedAt: '2026-07-19T23:45:00.000Z' }))
      .toMatch(/^local:[a-f0-9]{16}$/)
  })
})
