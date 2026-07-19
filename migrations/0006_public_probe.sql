CREATE TABLE IF NOT EXISTS public_probe_runs (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  probe_run_id TEXT PRIMARY KEY,
  evaluated_at TEXT NOT NULL,
  probe_date TEXT NOT NULL,
  completed_at TEXT,
  result TEXT NOT NULL CHECK (result IN ('running', 'success', 'failed')),
  failure_count INTEGER NOT NULL CHECK (failure_count >= 0)
);

CREATE TABLE IF NOT EXISTS public_probe_city_attempts (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  probe_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  probe_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'healthy', 'realtime_degraded', 'hard_failed', 'unknown', 'record_write_failed'
  )),
  active_version TEXT,
  observed_version TEXT,
  failure_class TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 10),
  warning_count INTEGER NOT NULL CHECK (warning_count BETWEEN 0 AND 16),
  warnings TEXT NOT NULL,
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  latency_bucket TEXT NOT NULL,
  PRIMARY KEY (probe_run_id, city_code),
  FOREIGN KEY (probe_run_id) REFERENCES public_probe_runs(probe_run_id)
);

CREATE TABLE IF NOT EXISTS public_probe_city_results (
  probe_schema_version INTEGER NOT NULL CHECK (probe_schema_version = 1),
  probe_run_id TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  probe_date TEXT NOT NULL,
  city_code TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'healthy', 'realtime_degraded', 'hard_failed', 'unknown', 'record_write_failed'
  )),
  active_version TEXT,
  observed_version TEXT,
  failure_class TEXT NOT NULL,
  hard_checks_passed INTEGER NOT NULL CHECK (hard_checks_passed BETWEEN 0 AND 10),
  warning_count INTEGER NOT NULL CHECK (warning_count BETWEEN 0 AND 16),
  warnings TEXT NOT NULL,
  probe_case_version INTEGER NOT NULL CHECK (probe_case_version >= 1),
  sample_case_id TEXT NOT NULL,
  latency_bucket TEXT NOT NULL,
  PRIMARY KEY (probe_date, city_code)
);

CREATE INDEX IF NOT EXISTS public_probe_city_results_status_idx
  ON public_probe_city_results(probe_date, status);
