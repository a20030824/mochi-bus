import { appendFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { snapshotWindowIdentity } from './window-contract.mjs'
import { queryD1, TRANSIT_D1_DATABASE_ID } from './window-d1.mjs'

const SNAPSHOT_VERSION = /^\d{8}T\d{9}Z$/

const PREFLIGHT_SQL = `
SELECT
  p.active_version,
  p.previous_version,
  p.active_probe_result,
  p.probe_failure_class,
  p.rollback_available,
  p.hard_checks_passed,
  p.diagnostic_warnings,
  d.active_version AS d1_active
FROM snapshot_active_probes p
JOIN dataset_versions d ON d.city_code = p.city_code
WHERE p.city_code = ?
ORDER BY p.active_probe_at DESC
LIMIT 1
`

const POSTFLIGHT_SQL = `
SELECT
  w.result,
  w.active_version AS window_active,
  w.previous_version AS window_previous,
  w.failure_class,
  w.run_kind,
  w.force_publish,
  p.active_probe_result,
  p.probe_failure_class,
  p.rollback_available,
  p.active_version AS probe_active,
  p.previous_version AS probe_previous,
  p.hard_checks_passed,
  p.diagnostic_warnings,
  d.active_version AS d1_active
FROM snapshot_windows w
JOIN snapshot_active_probes p
  ON p.city_code = w.city_code
  AND p.window_id = w.window_id
JOIN dataset_versions d ON d.city_code = w.city_code
WHERE w.city_code = ? AND w.window_id = ?
LIMIT 1
`

export function validateLegacyPreviousRepairRequest({
  city,
  expectedActive,
  expectedPrevious,
  forcePublish,
  windowType,
}) {
  if (typeof city !== 'string' || city.length === 0 || /\s/.test(city)) {
    throw new Error('Legacy previous repair requires one city')
  }
  if (!SNAPSHOT_VERSION.test(expectedActive ?? '')) {
    throw new Error('Legacy previous repair expected active version is invalid')
  }
  if (!SNAPSHOT_VERSION.test(expectedPrevious ?? '')) {
    throw new Error('Legacy previous repair expected previous version is invalid')
  }
  if (expectedActive === expectedPrevious) {
    throw new Error('Legacy previous repair versions must differ')
  }
  if (forcePublish !== true) {
    throw new Error('Legacy previous repair requires force publish')
  }
  if (windowType !== 'manual') {
    throw new Error('Legacy previous repair requires a manual window')
  }
  snapshotWindowIdentity({ city, windowType: 'manual' })
  return Object.freeze({ city, expectedActive, expectedPrevious })
}

export function assertLegacyPreviousRepairPreflight(rows, expected) {
  const row = onlyRow(rows, 'preflight')
  const warnings = parseWarnings(row.diagnostic_warnings, 'preflight')
  if (row.d1_active !== expected.expectedActive
    || row.active_version !== expected.expectedActive
    || row.previous_version !== expected.expectedPrevious
    || row.active_probe_result !== 'degraded'
    || row.probe_failure_class !== 'previous_unavailable'
    || Number(row.rollback_available) !== 0
    || Number(row.hard_checks_passed) !== 11
    || warnings.length !== 1
    || warnings[0] !== 'previous_unavailable') {
    throw new Error('Legacy previous repair preflight state changed')
  }
  return Object.freeze({
    city: expected.city,
    activeVersion: expected.expectedActive,
    previousVersion: expected.expectedPrevious,
  })
}

export function assertLegacyPreviousRepairPostflight(rows, expected, windowId) {
  const row = onlyRow(rows, 'postflight')
  const warnings = parseWarnings(row.diagnostic_warnings, 'postflight')
  if (row.result !== 'published'
    || row.failure_class !== 'none'
    || row.run_kind !== 'manual'
    || Number(row.force_publish) !== 1
    || row.active_probe_result !== 'success'
    || row.probe_failure_class !== 'none'
    || Number(row.rollback_available) !== 1
    || Number(row.hard_checks_passed) !== 11
    || warnings.length !== 0
    || row.window_previous !== expected.expectedActive
    || row.probe_previous !== expected.expectedActive
    || row.window_active !== row.probe_active
    || row.window_active !== row.d1_active
    || row.window_active === expected.expectedActive) {
    throw new Error('Legacy previous repair postflight verification failed')
  }
  return Object.freeze({
    city: expected.city,
    windowId,
    previousActive: expected.expectedActive,
    newActive: row.d1_active,
    hardChecksPassed: 11,
    rollbackAvailable: true,
  })
}

export async function runLegacyPreviousRepairPreflight({
  city,
  expectedActive,
  expectedPrevious,
  accountId,
  apiToken,
  databaseId = TRANSIT_D1_DATABASE_ID,
  fetchImpl = fetch,
}) {
  const expected = validateLegacyPreviousRepairRequest({
    city,
    expectedActive,
    expectedPrevious,
    forcePublish: true,
    windowType: 'manual',
  })
  const rows = await queryD1({
    accountId,
    apiToken,
    databaseId,
    fetchImpl,
    sql: PREFLIGHT_SQL,
    params: [city],
  })
  return assertLegacyPreviousRepairPreflight(rows, expected)
}

export async function runLegacyPreviousRepairPostflight({
  city,
  expectedActive,
  expectedPrevious,
  windowDate,
  accountId,
  apiToken,
  databaseId = TRANSIT_D1_DATABASE_ID,
  fetchImpl = fetch,
}) {
  const expected = validateLegacyPreviousRepairRequest({
    city,
    expectedActive,
    expectedPrevious,
    forcePublish: true,
    windowType: 'manual',
  })
  const { windowId } = snapshotWindowIdentity({
    city,
    windowType: 'manual',
    windowDate: windowDate || undefined,
  })
  const rows = await queryD1({
    accountId,
    apiToken,
    databaseId,
    fetchImpl,
    sql: POSTFLIGHT_SQL,
    params: [city, windowId],
  })
  return assertLegacyPreviousRepairPostflight(rows, expected, windowId)
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const [phase, city, expectedActive, expectedPrevious, windowDate = ''] = argv
  if (phase !== 'preflight' && phase !== 'postflight') {
    throw new Error('Usage: snapshot:repair-legacy-previous -- <preflight|postflight> <city> <expected-active> <expected-previous> [window-date]')
  }
  const expected = validateLegacyPreviousRepairRequest({
    city,
    expectedActive,
    expectedPrevious,
    forcePublish: env.SNAPSHOT_FORCE === '1',
    windowType: env.SNAPSHOT_WINDOW_TYPE,
  })
  const common = {
    ...expected,
    accountId: env.CLOUDFLARE_ACCOUNT_ID,
    apiToken: env.CLOUDFLARE_API_TOKEN,
  }
  const result = phase === 'preflight'
    ? await runLegacyPreviousRepairPreflight(common)
    : await runLegacyPreviousRepairPostflight({ ...common, windowDate })
  console.log(JSON.stringify({ event: `legacy_previous_repair_${phase}`, ...result }))
  if (phase === 'postflight' && env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, [
      `## ${result.city} legacy rollback repair`,
      '',
      `- Window: \`${result.windowId}\``,
      `- Previous active retained for rollback: \`${result.previousActive}\``,
      `- New active: \`${result.newActive}\``,
      '- Hard checks: `11/11`',
      '- Rollback available: `true`',
      '',
    ].join('\n'))
  }
}

function onlyRow(rows, phase) {
  if (!Array.isArray(rows) || rows.length !== 1 || !rows[0] || typeof rows[0] !== 'object') {
    throw new Error(`Legacy previous repair ${phase} evidence is incomplete`)
  }
  return rows[0]
}

function parseWarnings(value, phase) {
  try {
    const warnings = JSON.parse(value)
    if (!Array.isArray(warnings) || warnings.some((warning) => typeof warning !== 'string')) throw new Error()
    return warnings
  } catch {
    throw new Error(`Legacy previous repair ${phase} warnings are invalid`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
