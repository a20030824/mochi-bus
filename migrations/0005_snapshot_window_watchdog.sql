CREATE TABLE IF NOT EXISTS snapshot_window_record_failures (
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  failure_class TEXT NOT NULL CHECK (failure_class = 'record_write_failed'),
  PRIMARY KEY (city_code, window_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS snapshot_window_record_failures_window_idx
  ON snapshot_window_record_failures(city_code, window_id, recorded_at DESC);

CREATE TABLE IF NOT EXISTS snapshot_watchdog_runs (
  watchdog_schema_version INTEGER NOT NULL CHECK (watchdog_schema_version = 1),
  watchdog_run_id TEXT PRIMARY KEY,
  evaluated_at TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('running', 'success', 'failed')),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0)
);

CREATE TABLE IF NOT EXISTS snapshot_watchdog_city_attempts (
  watchdog_schema_version INTEGER NOT NULL CHECK (watchdog_schema_version = 1),
  watchdog_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'published', 'unchanged_healthy', 'unchanged_rollback_degraded',
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

CREATE TABLE IF NOT EXISTS snapshot_watchdog_city_results (
  watchdog_schema_version INTEGER NOT NULL CHECK (watchdog_schema_version = 1),
  watchdog_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  schedule_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'published', 'unchanged_healthy', 'unchanged_rollback_degraded',
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

CREATE INDEX IF NOT EXISTS snapshot_watchdog_city_results_status_idx
  ON snapshot_watchdog_city_results(schedule_date, status);
