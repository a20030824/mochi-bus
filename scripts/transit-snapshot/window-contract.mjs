import { createHash } from 'node:crypto'

export const SNAPSHOT_WINDOW_SCHEMA_VERSION = 1
export const SNAPSHOT_WINDOW_EVENT_SCHEMA = 4
export const SNAPSHOT_WINDOW_RESULTS = Object.freeze(['published', 'unchanged', 'failed'])
export const SNAPSHOT_WINDOW_FAILURE_CLASSES = Object.freeze([
  'none',
  'snapshot_source_fetch',
  'snapshot_source_compare',
  'snapshot_active_pointer_read',
  'snapshot_local_validation',
  'snapshot_stage',
  'snapshot_remote_validation',
  'snapshot_activate',
  'snapshot_smoke',
  'snapshot_rollback',
  'snapshot_finalize',
  'snapshot_window_record_write',
  'unknown',
])

const CITY_LOCAL_WEEKDAY = new Map([
  ...['Taipei', 'NewTaipei'].map((city) => [city, 1]),
  ...['Chiayi', 'Keelung', 'Hsinchu', 'HsinchuCounty'].map((city) => [city, 2]),
  ...['Tainan', 'MiaoliCounty', 'NantouCounty', 'PenghuCounty', 'KinmenCounty', 'LienchiangCounty']
    .map((city) => [city, 3]),
  ...['ChiayiCounty', 'ChanghuaCounty', 'PingtungCounty'].map((city) => [city, 4]),
  ['Taichung', 5],
  ...['Kaohsiung', 'YunlinCounty'].map((city) => [city, 6]),
  ...['Taoyuan', 'YilanCounty', 'HualienCounty', 'TaitungCounty'].map((city) => [city, 0]),
])

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const SAFE_SHA = /^[a-f0-9]{40}$/
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000
const SCHEDULE_HOUR = 3
const SCHEDULE_MINUTE = 17

export function snapshotWindowIdentity({ city, now = new Date(), windowType = 'scheduled', windowDate }) {
  assertCity(city)
  if (windowType !== 'scheduled' && windowType !== 'manual') throw new Error('Invalid snapshot window type')
  const current = validDate(now)
  const localDate = windowDate === undefined || windowDate === ''
    ? windowType === 'scheduled' ? latestScheduledLocalDate(city, current) : taipeiDate(current)
    : validDateOnly(windowDate)
  const slot = windowType === 'scheduled' ? '0317' : 'manual'
  const scheduledAt = windowType === 'scheduled'
    ? taipeiLocalTimeAsUtc(localDate, SCHEDULE_HOUR, SCHEDULE_MINUTE).toISOString()
    : taipeiLocalTimeAsUtc(localDate, 0, 0).toISOString()
  return Object.freeze({
    windowId: `v1:${city}:${localDate}:${slot}`,
    scheduledAt,
    runKind: windowType,
  })
}

export function snapshotAttemptId({ city, workflowRunId, workflowRunAttempt = 1, startedAt }) {
  assertCity(city)
  const attempt = positiveInteger(workflowRunAttempt)
  if (workflowRunId !== null && workflowRunId !== undefined && workflowRunId !== '') {
    const run = safeIdentifier(String(workflowRunId))
    return `gh:${run}:${attempt}:${city}`
  }
  const start = validIso(startedAt)
  return `local:${city}:${createHash('sha256').update(start).digest('hex').slice(0, 16)}`
}

export function snapshotFailureClass(phase) {
  const value = `snapshot_${String(phase ?? '').replaceAll('-', '_')}`
  return SNAPSHOT_WINDOW_FAILURE_CLASSES.includes(value) ? value : 'unknown'
}

export function snapshotProgressMarker(city, phase, fields = {}, now = new Date()) {
  assertCity(city)
  const allowedPhases = new Set([
    'source_fetch', 'source_compare', 'active_pointer_read', 'local_validation',
    'stage', 'remote_validation', 'activate', 'smoke', 'rollback', 'finalize',
  ])
  if (!allowedPhases.has(phase)) throw new Error('Invalid snapshot progress phase')
  return Object.freeze({
    event: 'snapshot_window_progress',
    city,
    phase,
    at: validDate(now).toISOString(),
    ...(fields.lastSourceCheckAt ? { lastSourceCheckAt: validIso(fields.lastSourceCheckAt) } : {}),
    ...(fields.lastPublishedAt ? { lastPublishedAt: validIso(fields.lastPublishedAt) } : {}),
    ...(fields.activeVersion ? { activeVersion: safeIdentifier(fields.activeVersion) } : {}),
    ...(fields.previousVersion ? { previousVersion: safeIdentifier(fields.previousVersion) } : {}),
  })
}

export function snapshotTerminalMarker(city, result, fields = {}, now = new Date()) {
  assertCity(city)
  if (result !== 'published' && result !== 'unchanged') throw new Error('Publisher terminal marker must be successful')
  return Object.freeze({
    event: 'snapshot_window_terminal',
    city,
    result,
    at: validDate(now).toISOString(),
    ...(fields.lastSourceCheckAt ? { lastSourceCheckAt: validIso(fields.lastSourceCheckAt) } : {}),
    ...(fields.lastPublishedAt ? { lastPublishedAt: validIso(fields.lastPublishedAt) } : {}),
    ...(fields.activeVersion ? { activeVersion: safeIdentifier(fields.activeVersion) } : {}),
    ...(fields.previousVersion ? { previousVersion: safeIdentifier(fields.previousVersion) } : {}),
  })
}

export function parsePublisherMarker(value, city) {
  if (!value || typeof value !== 'object' || value.city !== city) return undefined
  try {
    if (value.event === 'snapshot_window_progress') {
      return snapshotProgressMarker(city, value.phase, value, new Date(validIso(value.at)))
    }
    if (value.event === 'snapshot_window_terminal') {
      return snapshotTerminalMarker(city, value.result, value, new Date(validIso(value.at)))
    }
  } catch {
    return undefined
  }
  return undefined
}

export function createSnapshotWindowEvent(outcome, releaseSha = null) {
  const safe = validateWindowOutcome(outcome)
  const failed = safe.result === 'failed'
  return Object.freeze({
    eventSchema: SNAPSHOT_WINDOW_EVENT_SCHEMA,
    event: 'snapshot_window_completed',
    releaseSha: releaseSha && SAFE_SHA.test(releaseSha) ? releaseSha : null,
    workerVersionId: null,
    workerCreatedAt: null,
    deploymentId: null,
    city: safe.city,
    operation: 'snapshot_publish',
    result: failed ? 'error' : 'success',
    source: failed ? 'none' : 'snapshot',
    snapshotVersion: safe.activeVersion,
    httpStatusClass: 'none',
    latencyBucket: latencyBucket(Date.parse(safe.completedAt) - Date.parse(safe.startedAt)),
    cacheResult: 'not_applicable',
    trafficClass: 'snapshot_publish',
    sampleProbability: 1,
    failureClass: safe.failureClass,
    emptyReason: 'not_applicable',
    qualityBucket: 'not_applicable',
    windowId: safe.windowId,
    windowResult: safe.result,
    activeVersion: safe.activeVersion,
    previousVersion: safe.previousVersion,
    workflowRunId: safe.workflowRunId,
  })
}

export function validateWindowOutcome(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid snapshot window outcome')
  assertCity(value.city)
  if (!SNAPSHOT_WINDOW_RESULTS.includes(value.result)) throw new Error('Invalid snapshot window result')
  if (!SNAPSHOT_WINDOW_FAILURE_CLASSES.includes(value.failureClass)) throw new Error('Invalid snapshot failure class')
  if (value.result === 'failed' ? value.failureClass === 'none' : value.failureClass !== 'none') {
    throw new Error('Snapshot result and failure class conflict')
  }
  if (value.runKind !== 'scheduled' && value.runKind !== 'manual') throw new Error('Invalid snapshot run kind')
  return Object.freeze({
    schemaVersion: SNAPSHOT_WINDOW_SCHEMA_VERSION,
    city: value.city,
    windowId: safeIdentifier(value.windowId),
    attemptId: safeIdentifier(value.attemptId),
    scheduledAt: validIso(value.scheduledAt),
    startedAt: validIso(value.startedAt),
    completedAt: validIso(value.completedAt),
    result: value.result,
    lastSourceCheckAt: nullableIso(value.lastSourceCheckAt),
    lastPublishedAt: nullableIso(value.lastPublishedAt),
    activeVersion: nullableIdentifier(value.activeVersion),
    previousVersion: nullableIdentifier(value.previousVersion),
    workflowRunId: nullableIdentifier(value.workflowRunId),
    workflowRunAttempt: positiveInteger(value.workflowRunAttempt),
    scriptGitSha: value.scriptGitSha && SAFE_SHA.test(value.scriptGitSha) ? value.scriptGitSha : null,
    failureClass: value.failureClass,
    runKind: value.runKind,
    forcePublish: value.forcePublish === true,
  })
}

export function safeWindowSummary(outcome, durableRecordWrite) {
  const safe = validateWindowOutcome(outcome)
  return parseWindowSummary({
    schemaVersion: 1,
    city: safe.city,
    windowId: safe.windowId,
    result: safe.result,
    activeVersion: safe.activeVersion,
    previousVersion: safe.previousVersion,
    lastSourceCheckAt: safe.lastSourceCheckAt,
    lastPublishedAt: safe.lastPublishedAt,
    failureClass: safe.failureClass,
    durableRecordWrite: durableRecordWrite === 'success' ? 'success' : 'failed',
  })
}

export function parseWindowSummary(value) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1) throw new Error('Invalid window summary')
  assertCity(value.city)
  if (!SNAPSHOT_WINDOW_RESULTS.includes(value.result)) throw new Error('Invalid window summary result')
  if (!SNAPSHOT_WINDOW_FAILURE_CLASSES.includes(value.failureClass)) throw new Error('Invalid window summary failure class')
  if (value.durableRecordWrite !== 'success' && value.durableRecordWrite !== 'failed') {
    throw new Error('Invalid durable record status')
  }
  return Object.freeze({
    schemaVersion: 1,
    city: value.city,
    windowId: safeIdentifier(value.windowId),
    result: value.result,
    activeVersion: nullableIdentifier(value.activeVersion),
    previousVersion: nullableIdentifier(value.previousVersion),
    lastSourceCheckAt: nullableIso(value.lastSourceCheckAt),
    lastPublishedAt: nullableIso(value.lastPublishedAt),
    failureClass: value.failureClass,
    durableRecordWrite: value.durableRecordWrite,
  })
}

function latestScheduledLocalDate(city, now) {
  const weekday = CITY_LOCAL_WEEKDAY.get(city)
  const local = new Date(now.getTime() + TAIPEI_OFFSET_MS)
  const beforeSlot = local.getUTCHours() < SCHEDULE_HOUR
    || (local.getUTCHours() === SCHEDULE_HOUR && local.getUTCMinutes() < SCHEDULE_MINUTE)
  let daysBack = (local.getUTCDay() - weekday + 7) % 7
  if (daysBack === 0 && beforeSlot) daysBack = 7
  local.setUTCDate(local.getUTCDate() - daysBack)
  return dateParts(local)
}

function taipeiDate(now) {
  return dateParts(new Date(now.getTime() + TAIPEI_OFFSET_MS))
}

function dateParts(value) {
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`
}

function taipeiLocalTimeAsUtc(date, hour, minute) {
  const [year, month, day] = date.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, day, hour, minute) - TAIPEI_OFFSET_MS)
}

function validDateOnly(value) {
  if (!DATE_ONLY.test(value)) throw new Error('Invalid snapshot window date')
  const parsed = new Date(`${value}T00:00:00.000Z`)
  if (Number.isNaN(parsed.getTime()) || dateParts(parsed) !== value) throw new Error('Invalid snapshot window date')
  return value
}

function validDate(value) {
  const date = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(date.getTime())) throw new Error('Invalid timestamp')
  return date
}

function validIso(value) {
  if (typeof value !== 'string' || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    throw new Error('Invalid ISO timestamp')
  }
  return value
}

function nullableIso(value) {
  return value === null || value === undefined ? null : validIso(value)
}

function safeIdentifier(value) {
  const text = String(value)
  if (!SAFE_IDENTIFIER.test(text)) throw new Error('Invalid identifier')
  return text
}

function nullableIdentifier(value) {
  return value === null || value === undefined || value === '' ? null : safeIdentifier(value)
}

function positiveInteger(value) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new Error('Invalid positive integer')
  return number
}

function assertCity(city) {
  if (!CITY_LOCAL_WEEKDAY.has(city)) throw new Error('Unsupported snapshot city')
}

function latencyBucket(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 50) return 'lt_50ms'
  if (milliseconds < 200) return '50_199ms'
  if (milliseconds < 1_000) return '200_999ms'
  if (milliseconds < 3_000) return '1_3s'
  if (milliseconds <= 6_000) return '3_6s'
  return 'gt_6s'
}
