CREATE TABLE IF NOT EXISTS snapshot_window_attempts (
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  result TEXT CHECK (result IS NULL OR result IN ('published', 'unchanged', 'failed')),
  last_source_check_at TEXT,
  last_published_at TEXT,
  active_version TEXT,
  previous_version TEXT,
  workflow_run_id TEXT,
  workflow_run_attempt INTEGER NOT NULL CHECK (workflow_run_attempt >= 1),
  script_git_sha TEXT,
  failure_class TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('scheduled', 'manual')),
  force_publish INTEGER NOT NULL CHECK (force_publish IN (0, 1)),
  PRIMARY KEY (city_code, window_id, attempt_id)
);

CREATE INDEX IF NOT EXISTS snapshot_window_attempts_workflow_idx
  ON snapshot_window_attempts(city_code, workflow_run_id, workflow_run_attempt);

CREATE TABLE IF NOT EXISTS snapshot_windows (
  schema_version INTEGER NOT NULL CHECK (schema_version = 1),
  city_code TEXT NOT NULL,
  window_id TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  result TEXT NOT NULL CHECK (result IN ('published', 'unchanged', 'failed')),
  last_source_check_at TEXT,
  last_published_at TEXT,
  active_version TEXT,
  previous_version TEXT,
  workflow_run_id TEXT,
  workflow_run_attempt INTEGER NOT NULL CHECK (workflow_run_attempt >= 1),
  script_git_sha TEXT,
  failure_class TEXT NOT NULL,
  run_kind TEXT NOT NULL CHECK (run_kind IN ('scheduled', 'manual')),
  force_publish INTEGER NOT NULL CHECK (force_publish IN (0, 1)),
  PRIMARY KEY (city_code, window_id)
);

CREATE INDEX IF NOT EXISTS snapshot_windows_completed_idx
  ON snapshot_windows(city_code, completed_at DESC);
