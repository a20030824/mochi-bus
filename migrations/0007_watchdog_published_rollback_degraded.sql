-- SQLite cannot alter CHECK constraints in place. Rebuild the two watchdog city
-- tables so a successfully published active snapshot can retain an explicit
-- rollback-degraded status instead of being collapsed into unknown.

CREATE TABLE snapshot_watchdog_city_attempts_status_v2 (
  watchdog_schema_version INTEGER NOT NULL CHECK (watchdog_schema_version = 1),
  watchdog_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'published', 'published_rollback_degraded',
    'unchanged_healthy', 'unchanged_rollback_degraded',
    'failed_active_healthy', 'failed_active_unhealthy', 'missing',
    'record_write_failed', 'unknown'
  )),
  active_version TEXT,
  window_result TEXT CHECK (window_result IS NULL OR window_result IN ('published', 'unchanged', 'failed')),
  probe_result TEXT NOT NULL CHECK (probe_result IN ('success', 'degraded', 'error', 'missing', 'expired')),
  rollback_available INTEGER CHECK (rollback_available IS NULL OR rollback_available IN (0, 1)),
  signal_age_bucket TEXT NOT NULL CHECK (signal_age_bucket IN ('same_window', 'lt_24h', '1_7d', '7_8d', 'expired', 'none')),
  source_check_age_bucket TEXT NOT NULL CHECK (source_check_age_bucket IN ('same_window', 'lt_24h', '1_7d', '7_8d', 'expired', 'none')),
  probe_window_distance INTEGER CHECK (probe_window_distance IS NULL OR probe_window_distance BETWEEN 0 AND 52),
  diagnostic_class TEXT NOT NULL CHECK (diagnostic_class IN (
    'none', 'window_terminal_missing', 'attempt_incomplete', 'window_record_missing',
    'probe_record_missing', 'probe_evidence_expired', 'window_probe_conflict',
    'active_version_conflict', 'rollback_unavailable', 'record_write_failed',
    'unsupported_schema', 'watchdog_query_failed', 'window_failed_active_healthy',
    'active_probe_failed', 'unknown'
  )),
  source_record_version TEXT NOT NULL,
  last_source_check_at TEXT,
  active_probe_at TEXT,
  PRIMARY KEY (watchdog_run_id, city_code),
  FOREIGN KEY (watchdog_run_id) REFERENCES snapshot_watchdog_runs(watchdog_run_id)
);

INSERT INTO snapshot_watchdog_city_attempts_status_v2 (
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
  city_code, window_id, status, active_version, window_result, probe_result,
  rollback_available, signal_age_bucket, source_check_age_bucket,
  probe_window_distance, diagnostic_class, source_record_version,
  last_source_check_at, active_probe_at
)
SELECT
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
  city_code, window_id, status, active_version, window_result, probe_result,
  rollback_available, signal_age_bucket, source_check_age_bucket,
  probe_window_distance, diagnostic_class, source_record_version,
  last_source_check_at, active_probe_at
FROM snapshot_watchdog_city_attempts;

DROP TABLE snapshot_watchdog_city_attempts;
ALTER TABLE snapshot_watchdog_city_attempts_status_v2 RENAME TO snapshot_watchdog_city_attempts;

CREATE TABLE snapshot_watchdog_city_results_status_v2 (
  watchdog_schema_version INTEGER NOT NULL CHECK (watchdog_schema_version = 1),
  watchdog_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'published', 'published_rollback_degraded',
    'unchanged_healthy', 'unchanged_rollback_degraded',
    'failed_active_healthy', 'failed_active_unhealthy', 'missing',
    'record_write_failed', 'unknown'
  )),
  active_version TEXT,
  window_result TEXT CHECK (window_result IS NULL OR window_result IN ('published', 'unchanged', 'failed')),
  probe_result TEXT NOT NULL CHECK (probe_result IN ('success', 'degraded', 'error', 'missing', 'expired')),
  rollback_available INTEGER CHECK (rollback_available IS NULL OR rollback_available IN (0, 1)),
  signal_age_bucket TEXT NOT NULL CHECK (signal_age_bucket IN ('same_window', 'lt_24h', '1_7d', '7_8d', 'expired', 'none')),
  source_check_age_bucket TEXT NOT NULL CHECK (source_check_age_bucket IN ('same_window', 'lt_24h', '1_7d', '7_8d', 'expired', 'none')),
  probe_window_distance INTEGER CHECK (probe_window_distance IS NULL OR probe_window_distance BETWEEN 0 AND 52),
  diagnostic_class TEXT NOT NULL CHECK (diagnostic_class IN (
    'none', 'window_terminal_missing', 'attempt_incomplete', 'window_record_missing',
    'probe_record_missing', 'probe_evidence_expired', 'window_probe_conflict',
    'active_version_conflict', 'rollback_unavailable', 'record_write_failed',
    'unsupported_schema', 'watchdog_query_failed', 'window_failed_active_healthy',
    'active_probe_failed', 'unknown'
  )),
  source_record_version TEXT NOT NULL,
  last_source_check_at TEXT,
  active_probe_at TEXT,
  PRIMARY KEY (schedule_date, city_code)
);

INSERT INTO snapshot_watchdog_city_results_status_v2 (
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
  city_code, window_id, status, active_version, window_result, probe_result,
  rollback_available, signal_age_bucket, source_check_age_bucket,
  probe_window_distance, diagnostic_class, source_record_version,
  last_source_check_at, active_probe_at
)
SELECT
  watchdog_schema_version, watchdog_run_id, evaluated_at, schedule_date,
  city_code, window_id, status, active_version, window_result, probe_result,
  rollback_available, signal_age_bucket, source_check_age_bucket,
  probe_window_distance, diagnostic_class, source_record_version,
  last_source_check_at, active_probe_at
FROM snapshot_watchdog_city_results;

DROP TABLE snapshot_watchdog_city_results;
ALTER TABLE snapshot_watchdog_city_results_status_v2 RENAME TO snapshot_watchdog_city_results;
CREATE INDEX snapshot_watchdog_city_results_status_idx
  ON snapshot_watchdog_city_results(schedule_date, status);
