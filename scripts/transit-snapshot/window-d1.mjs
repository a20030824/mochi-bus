import { validateWindowOutcome } from './window-contract.mjs'

export const TRANSIT_D1_DATABASE_ID = 'e5680212-29c5-4045-acd2-1e5df703e751'

export const INSERT_WINDOW_ATTEMPT_SQL = `
INSERT INTO snapshot_window_attempts (
  schema_version, city_code, window_id, attempt_id, scheduled_at, started_at,
  completed_at, result, last_source_check_at, last_published_at, active_version,
  previous_version, workflow_run_id, workflow_run_attempt, script_git_sha,
  failure_class, run_kind, force_publish
) VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?, 'none', ?, ?)
ON CONFLICT(city_code, window_id, attempt_id) DO NOTHING
`

export const COMPLETE_WINDOW_ATTEMPT_SQL = `
INSERT INTO snapshot_window_attempts (
  schema_version, city_code, window_id, attempt_id, scheduled_at, started_at,
  completed_at, result, last_source_check_at, last_published_at, active_version,
  previous_version, workflow_run_id, workflow_run_attempt, script_git_sha,
  failure_class, run_kind, force_publish
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(city_code, window_id, attempt_id) DO UPDATE SET
  completed_at=excluded.completed_at,
  result=excluded.result,
  last_source_check_at=excluded.last_source_check_at,
  last_published_at=excluded.last_published_at,
  active_version=excluded.active_version,
  previous_version=excluded.previous_version,
  workflow_run_id=excluded.workflow_run_id,
  workflow_run_attempt=excluded.workflow_run_attempt,
  script_git_sha=excluded.script_git_sha,
  failure_class=excluded.failure_class,
  run_kind=excluded.run_kind,
  force_publish=excluded.force_publish
`

export const UPSERT_CANONICAL_WINDOW_SQL = `
INSERT INTO snapshot_windows (
  schema_version, city_code, window_id, scheduled_at, started_at, completed_at,
  result, last_source_check_at, last_published_at, active_version, previous_version,
  workflow_run_id, workflow_run_attempt, script_git_sha, failure_class, run_kind,
  force_publish
) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(city_code, window_id) DO UPDATE SET
  schema_version=excluded.schema_version,
  scheduled_at=excluded.scheduled_at,
  started_at=excluded.started_at,
  completed_at=excluded.completed_at,
  result=excluded.result,
  last_source_check_at=excluded.last_source_check_at,
  last_published_at=excluded.last_published_at,
  active_version=excluded.active_version,
  previous_version=excluded.previous_version,
  workflow_run_id=excluded.workflow_run_id,
  workflow_run_attempt=excluded.workflow_run_attempt,
  script_git_sha=excluded.script_git_sha,
  failure_class=excluded.failure_class,
  run_kind=excluded.run_kind,
  force_publish=excluded.force_publish
WHERE
  (excluded.started_at > snapshot_windows.started_at
    OR (excluded.started_at = snapshot_windows.started_at
      AND excluded.completed_at >= snapshot_windows.completed_at))
  AND (CASE excluded.result WHEN 'published' THEN 2 WHEN 'unchanged' THEN 1 ELSE 0 END)
    >= (CASE snapshot_windows.result WHEN 'published' THEN 2 WHEN 'unchanged' THEN 1 ELSE 0 END)
`

const FIND_WORKFLOW_WINDOW_SQL = `
SELECT window_id, scheduled_at, run_kind
FROM snapshot_window_attempts
WHERE city_code = ? AND workflow_run_id = ?
ORDER BY workflow_run_attempt DESC, started_at DESC
LIMIT 1
`

const ACTIVE_SNAPSHOT_SQL = `
SELECT active_version, imported_at
FROM dataset_versions
WHERE city_code = ?
LIMIT 1
`

export function createD1WindowStore({
  accountId,
  apiToken,
  databaseId = TRANSIT_D1_DATABASE_ID,
  fetchImpl = fetch,
}) {
  if (!accountId || !apiToken || !databaseId) throw new Error('Missing D1 window store configuration')
  const query = (sql, params) => queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params })

  return Object.freeze({
    async findWindowForWorkflowRun(city, workflowRunId) {
      if (!workflowRunId) return null
      const rows = await query(FIND_WORKFLOW_WINDOW_SQL, [city, String(workflowRunId)])
      const row = rows[0]
      return row ? {
        windowId: String(row.window_id),
        scheduledAt: String(row.scheduled_at),
        runKind: row.run_kind === 'manual' ? 'manual' : 'scheduled',
      } : null
    },

    async recordStart(attempt) {
      await query(INSERT_WINDOW_ATTEMPT_SQL, startParams(attempt))
    },

    async readActiveSnapshot(city) {
      const rows = await query(ACTIVE_SNAPSHOT_SQL, [city])
      const row = rows[0]
      return row ? {
        activeVersion: row.active_version === null ? null : String(row.active_version),
        lastPublishedAt: row.imported_at === null ? null : String(row.imported_at),
      } : { activeVersion: null, lastPublishedAt: null }
    },

    async complete(outcome) {
      const safe = validateWindowOutcome(outcome)
      await query(COMPLETE_WINDOW_ATTEMPT_SQL, completeAttemptParams(safe))
      await query(UPSERT_CANONICAL_WINDOW_SQL, canonicalParams(safe))
    },
  })
}

export async function queryD1({ accountId, apiToken, databaseId, fetchImpl, sql, params }) {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(15_000),
    },
  )
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new Error('D1 window query returned invalid JSON')
  }
  const result = Array.isArray(payload?.result) ? payload.result[0] : undefined
  if (!response.ok || payload?.success !== true || result?.success !== true || !Array.isArray(result.results)) {
    throw new Error('D1 window query failed')
  }
  return result.results
}

function startParams(value) {
  return [
    value.city,
    value.windowId,
    value.attemptId,
    value.scheduledAt,
    value.startedAt,
    value.workflowRunId,
    value.workflowRunAttempt,
    value.scriptGitSha,
    value.runKind,
    value.forcePublish ? 1 : 0,
  ]
}

function completeAttemptParams(value) {
  return [
    value.city,
    value.windowId,
    value.attemptId,
    value.scheduledAt,
    value.startedAt,
    value.completedAt,
    value.result,
    value.lastSourceCheckAt,
    value.lastPublishedAt,
    value.activeVersion,
    value.previousVersion,
    value.workflowRunId,
    value.workflowRunAttempt,
    value.scriptGitSha,
    value.failureClass,
    value.runKind,
    value.forcePublish ? 1 : 0,
  ]
}

function canonicalParams(value) {
  return [
    value.city,
    value.windowId,
    value.scheduledAt,
    value.startedAt,
    value.completedAt,
    value.result,
    value.lastSourceCheckAt,
    value.lastPublishedAt,
    value.activeVersion,
    value.previousVersion,
    value.workflowRunId,
    value.workflowRunAttempt,
    value.scriptGitSha,
    value.failureClass,
    value.runKind,
    value.forcePublish ? 1 : 0,
  ]
}
