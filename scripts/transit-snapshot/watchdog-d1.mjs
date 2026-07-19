import { createHash } from 'node:crypto'
import { queryD1, queryD1Batch, TRANSIT_D1_DATABASE_ID } from './window-d1.mjs'
import { validateWatchdogResult, WATCHDOG_SCHEMA_VERSION } from './watchdog-contract.mjs'

const WINDOW_SQL = `
SELECT schema_version, city_code, window_id, completed_at, result,
  last_source_check_at, last_published_at, active_version, previous_version, failure_class
FROM snapshot_windows
WHERE city_code = ? AND window_id = ?
LIMIT 1
`

const ATTEMPT_SUMMARY_SQL = `
SELECT COUNT(*) AS attempt_count,
  SUM(CASE WHEN completed_at IS NULL OR result IS NULL THEN 1 ELSE 0 END) AS incomplete_attempt_count
FROM snapshot_window_attempts
WHERE city_code = ? AND window_id = ?
`

const SAME_WINDOW_PROBE_SQL = `
SELECT probe_schema_version, city_code, window_id, active_version, previous_version,
  active_probe_at, active_probe_result, probe_failure_class, rollback_available
FROM snapshot_active_probes
WHERE city_code = ? AND window_id = ?
LIMIT 1
`

const LATEST_USABLE_PROBE_SQL = `
SELECT probe.probe_schema_version, probe.city_code, probe.window_id, probe.active_version, probe.previous_version,
  probe.active_probe_at, probe.active_probe_result, probe.probe_failure_class, probe.rollback_available
FROM snapshot_active_probes AS probe
JOIN dataset_versions AS active
  ON active.city_code = probe.city_code AND active.active_version = probe.active_version
WHERE probe.city_code = ? AND probe.active_probe_result IN ('success', 'degraded')
ORDER BY probe.active_probe_at DESC
LIMIT 1
`

const RECORD_FAILURE_SQL = `
SELECT failure.recorded_at
FROM snapshot_window_record_failures AS failure
LEFT JOIN snapshot_windows AS window
  ON window.city_code = failure.city_code AND window.window_id = failure.window_id
WHERE failure.city_code = ? AND failure.window_id = ?
  AND (window.completed_at IS NULL OR failure.recorded_at >= window.completed_at)
ORDER BY recorded_at DESC
LIMIT 1
`

const ACTIVE_POINTER_SQL = `
SELECT active_version
FROM dataset_versions
WHERE city_code = ?
LIMIT 1
`

const START_RUN_SQL = `
INSERT INTO snapshot_watchdog_runs (
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
  completed_at, result, failure_count
) VALUES (1, ?, ?, ?, NULL, 'running', 0)
ON CONFLICT(watchdog_run_id) DO UPDATE SET
  evaluated_at=excluded.evaluated_at,
  schedule_date=excluded.schedule_date,
  completed_at=NULL,
  result='running',
  failure_count=0
WHERE excluded.evaluated_at >= snapshot_watchdog_runs.evaluated_at
`

const COMPLETE_RUN_SQL = `
UPDATE snapshot_watchdog_runs
SET completed_at = ?, result = ?, failure_count = ?
WHERE watchdog_run_id = ? AND evaluated_at = ?
`

const INSERT_CITY_ATTEMPT_SQL = `
INSERT INTO snapshot_watchdog_city_attempts (
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date, city_code,
  window_id, status, active_version, window_result, probe_result, rollback_available,
  signal_age_bucket, source_check_age_bucket, probe_window_distance, diagnostic_class,
  source_record_version, last_source_check_at, active_probe_at
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(watchdog_run_id, city_code) DO UPDATE SET
  evaluated_at=excluded.evaluated_at,
  schedule_date=excluded.schedule_date,
  window_id=excluded.window_id,
  status=excluded.status,
  active_version=excluded.active_version,
  window_result=excluded.window_result,
  probe_result=excluded.probe_result,
  rollback_available=excluded.rollback_available,
  signal_age_bucket=excluded.signal_age_bucket,
  source_check_age_bucket=excluded.source_check_age_bucket,
  probe_window_distance=excluded.probe_window_distance,
  diagnostic_class=excluded.diagnostic_class,
  source_record_version=excluded.source_record_version,
  last_source_check_at=excluded.last_source_check_at,
  active_probe_at=excluded.active_probe_at
WHERE excluded.evaluated_at >= snapshot_watchdog_city_attempts.evaluated_at
`

const UPSERT_CANONICAL_CITY_SQL = `
INSERT INTO snapshot_watchdog_city_results (
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date, city_code,
  window_id, status, active_version, window_result, probe_result, rollback_available,
  signal_age_bucket, source_check_age_bucket, probe_window_distance, diagnostic_class,
  source_record_version, last_source_check_at, active_probe_at
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(schedule_date, city_code) DO UPDATE SET
  watchdog_schema_version=excluded.watchdog_schema_version,
  watchdog_run_id=excluded.watchdog_run_id,
  evaluated_at=excluded.evaluated_at,
  window_id=excluded.window_id,
  status=excluded.status,
  active_version=excluded.active_version,
  window_result=excluded.window_result,
  probe_result=excluded.probe_result,
  rollback_available=excluded.rollback_available,
  signal_age_bucket=excluded.signal_age_bucket,
  source_check_age_bucket=excluded.source_check_age_bucket,
  probe_window_distance=excluded.probe_window_distance,
  diagnostic_class=excluded.diagnostic_class,
  source_record_version=excluded.source_record_version,
  last_source_check_at=excluded.last_source_check_at,
  active_probe_at=excluded.active_probe_at
WHERE excluded.evaluated_at > snapshot_watchdog_city_results.evaluated_at
  OR (excluded.evaluated_at = snapshot_watchdog_city_results.evaluated_at
    AND excluded.watchdog_run_id >= snapshot_watchdog_city_results.watchdog_run_id)
`

export function createD1WatchdogStore({
  accountId,
  apiToken,
  databaseId = TRANSIT_D1_DATABASE_ID,
  fetchImpl = fetch,
}) {
  if (!accountId || !apiToken || !databaseId) throw new Error('Missing watchdog D1 configuration')
  const query = (sql, params) => queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params })
  const batch = (queries) => queryD1Batch({ accountId, apiToken, databaseId, fetchImpl, queries })
  return Object.freeze({
    async readEvidence(city, windowId) {
      const [windows, attempts, sameProbes, latestProbes, failures, activePointers] = await batch([
        { sql: WINDOW_SQL, params: [city, windowId] },
        { sql: ATTEMPT_SUMMARY_SQL, params: [city, windowId] },
        { sql: SAME_WINDOW_PROBE_SQL, params: [city, windowId] },
        { sql: LATEST_USABLE_PROBE_SQL, params: [city] },
        { sql: RECORD_FAILURE_SQL, params: [city, windowId] },
        { sql: ACTIVE_POINTER_SQL, params: [city] },
      ])
      return Object.freeze({
        window: windows[0] ? mapWindow(windows[0]) : null,
        attemptSummary: Object.freeze({
          attemptCount: Number(attempts[0]?.attempt_count ?? 0),
          incompleteAttemptCount: Number(attempts[0]?.incomplete_attempt_count ?? 0),
        }),
        sameWindowProbe: sameProbes[0] ? mapProbe(sameProbes[0]) : null,
        latestUsableProbe: latestProbes[0] ? mapProbe(latestProbes[0]) : null,
        recordWriteFailure: failures.length > 0,
        currentActiveVersion: activePointers[0]?.active_version === null || activePointers[0]?.active_version === undefined
          ? null
          : String(activePointers[0].active_version),
      })
    },

    async startRun({ watchdogRunId, evaluatedAt, scheduleDate }) {
      await query(START_RUN_SQL, [watchdogRunId, evaluatedAt, scheduleDate])
    },

    async completeCity(watchdogRunId, result) {
      const safe = validateWatchdogResult(result)
      const params = cityParams(watchdogRunId, safe)
      await batch([
        { sql: INSERT_CITY_ATTEMPT_SQL, params },
        { sql: UPSERT_CANONICAL_CITY_SQL, params },
      ])
    },

    async completeRun({ watchdogRunId, evaluatedAt, completedAt, result, failureCount }) {
      await query(COMPLETE_RUN_SQL, [completedAt, result, failureCount, watchdogRunId, evaluatedAt])
    },
  })
}

export function watchdogRunId({ workflowRunId, workflowRunAttempt = 1, evaluatedAt }) {
  if (workflowRunId) return `gh:${safeIdentifier(workflowRunId)}:${positiveInteger(workflowRunAttempt)}`
  const time = new Date(evaluatedAt).toISOString()
  return `local:${createHash('sha256').update(time).digest('hex').slice(0, 16)}`
}

function mapWindow(row) {
  return Object.freeze({
    schemaVersion: Number(row.schema_version),
    city: String(row.city_code),
    windowId: String(row.window_id),
    completedAt: String(row.completed_at),
    result: String(row.result),
    lastSourceCheckAt: row.last_source_check_at === null ? null : String(row.last_source_check_at),
    lastPublishedAt: row.last_published_at === null ? null : String(row.last_published_at),
    activeVersion: row.active_version === null ? null : String(row.active_version),
    previousVersion: row.previous_version === null ? null : String(row.previous_version),
    failureClass: String(row.failure_class),
  })
}

function mapProbe(row) {
  return Object.freeze({
    probeSchemaVersion: Number(row.probe_schema_version),
    city: String(row.city_code),
    windowId: String(row.window_id),
    activeVersion: row.active_version === null ? null : String(row.active_version),
    previousVersion: row.previous_version === null ? null : String(row.previous_version),
    activeProbeAt: String(row.active_probe_at),
    activeProbeResult: String(row.active_probe_result),
    probeFailureClass: String(row.probe_failure_class),
    rollbackAvailable: Number(row.rollback_available) === 1,
  })
}

function cityParams(watchdogRunIdValue, value) {
  return [
    watchdogRunIdValue,
    value.evaluatedAt,
    value.scheduleDate,
    value.city,
    value.windowId,
    value.status,
    value.activeVersion,
    value.windowResult,
    value.probeResult,
    value.rollbackAvailable === null ? null : value.rollbackAvailable ? 1 : 0,
    value.signalAgeBucket,
    value.sourceCheckAgeBucket,
    value.probeWindowDistance,
    value.diagnosticClass,
    value.sourceRecordVersion,
    value.lastSourceCheckAt,
    value.activeProbeAt,
  ]
}

function safeIdentifier(value) {
  const text = String(value)
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(text)) throw new Error('Invalid watchdog run identifier')
  return text
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid watchdog run attempt')
  return number
}
