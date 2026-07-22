import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const baseMigration = [3, 4, 5].map((number) => readFileSync(new URL(
  `../../migrations/${String(number).padStart(4, '0')}_${number === 3 ? 'snapshot_window_outcomes' : number === 4 ? 'snapshot_active_probes' : 'snapshot_window_watchdog'}.sql`,
  import.meta.url,
), 'utf8')).join('\n')
const statusMigration = readFileSync(new URL(
  '../../migrations/0007_watchdog_published_rollback_degraded.sql',
  import.meta.url,
), 'utf8')

describe('watchdog published rollback status migration', () => {
  let db

  beforeEach(() => {
    db = new DatabaseSync(':memory:')
    db.exec(baseMigration)
    db.prepare(`INSERT INTO snapshot_watchdog_runs (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      completed_at, result, failure_count
    ) VALUES (1, 'gh:old:1', '2026-07-22T01:09:16.867Z', '2026-07-22',
      '2026-07-22T01:09:17.000Z', 'failed', 1)`).run()
    db.prepare(`INSERT INTO snapshot_watchdog_city_attempts (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    ) VALUES (
      1, 'gh:old:1', '2026-07-22T01:09:16.867Z', '2026-07-22',
      'Tainan', 'v1:Tainan:2026-07-22:0317', 'published', 'v-old',
      'published', 'success', 1, 'same_window', 'lt_24h', 0, 'none',
      'window1_probe1', '2026-07-21T20:30:00.000Z', '2026-07-21T20:31:00.000Z'
    )`).run()
    db.prepare(`INSERT INTO snapshot_watchdog_city_results (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    ) SELECT
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    FROM snapshot_watchdog_city_attempts`).run()
  })

  afterEach(() => db.close())

  it('preserves existing rows and accepts the explicit published degraded status', () => {
    db.exec(statusMigration)

    expect(db.prepare(`SELECT city_code, status, rollback_available
      FROM snapshot_watchdog_city_attempts WHERE watchdog_run_id = 'gh:old:1'`).get())
      .toEqual({ city_code: 'Tainan', status: 'published', rollback_available: 1 })
    expect(db.prepare(`SELECT city_code, status
      FROM snapshot_watchdog_city_results WHERE schedule_date = '2026-07-22'`).get())
      .toEqual({ city_code: 'Tainan', status: 'published' })

    db.prepare(`INSERT INTO snapshot_watchdog_runs (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      completed_at, result, failure_count
    ) VALUES (1, 'gh:new:1', '2026-07-22T02:00:00.000Z', '2026-07-22',
      '2026-07-22T02:00:01.000Z', 'failed', 1)`).run()
    db.prepare(`INSERT INTO snapshot_watchdog_city_attempts (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    ) VALUES (
      1, 'gh:new:1', '2026-07-22T02:00:00.000Z', '2026-07-22',
      'MiaoliCounty', 'v1:MiaoliCounty:2026-07-22:0317',
      'published_rollback_degraded', 'v-new', 'published', 'degraded', 0,
      'same_window', 'lt_24h', 0, 'rollback_unavailable', 'window1_probe1',
      '2026-07-21T20:39:00.000Z', '2026-07-21T20:40:00.000Z'
    )`).run()
    db.prepare(`INSERT OR REPLACE INTO snapshot_watchdog_city_results (
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    ) SELECT
      watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
      city_code, window_id, status, active_version, window_result, probe_result,
      rollback_available, signal_age_bucket, source_check_age_bucket,
      probe_window_distance, diagnostic_class, source_record_version,
      last_source_check_at, active_probe_at
    FROM snapshot_watchdog_city_attempts WHERE watchdog_run_id = 'gh:new:1'`).run()

    expect(db.prepare(`SELECT status, window_result, probe_result,
      rollback_available, diagnostic_class
      FROM snapshot_watchdog_city_results
      WHERE schedule_date = '2026-07-22' AND city_code = 'MiaoliCounty'`).get())
      .toEqual({
        status: 'published_rollback_degraded',
        window_result: 'published',
        probe_result: 'degraded',
        rollback_available: 0,
        diagnostic_class: 'rollback_unavailable',
      })
    expect(db.prepare(`SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'snapshot_watchdog_city_results_status_idx'`).get())
      .toEqual({ name: 'snapshot_watchdog_city_results_status_idx' })
  })
})
