CREATE TABLE IF NOT EXISTS snapshot_probe_attempts (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_started_at TEXT NOT NULL,
  active_version TEXT,
  previous_version TEXT,
  active_probe_at TEXT NOT NULL,
  active_probe_result TEXT NOT NULL CHECK (active_probe_result IN ('success', 'degraded', 'error')),
  probe_failure_class TEXT NOT NULL,
  rollback_available INTEGER NOT NULL CHECK (rollback_available IN (0, 1)),
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 11),
  diagnostic_warnings TEXT NOT NULL,
  PRIMARY KEY (city_code, window_id, attempt_id),
  FOREIGN KEY (city_code, window_id, attempt_id)
    REFERENCES snapshot_window_attempts(city_code, window_id, attempt_id)
);

CREATE TABLE IF NOT EXISTS snapshot_active_probes (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempt_started_at TEXT NOT NULL,
  active_version TEXT,
  previous_version TEXT,
  active_probe_at TEXT NOT NULL,
  active_probe_result TEXT NOT NULL CHECK (active_probe_result IN ('success', 'degraded', 'error')),
  probe_failure_class TEXT NOT NULL,
  rollback_available INTEGER NOT NULL CHECK (rollback_available IN (0, 1)),
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 11),
  diagnostic_warnings TEXT NOT NULL,
  PRIMARY KEY (city_code, window_id)
);

CREATE INDEX IF NOT EXISTS snapshot_active_probes_checked_idx
  ON snapshot_active_probes(city_code, active_probe_at DESC);
