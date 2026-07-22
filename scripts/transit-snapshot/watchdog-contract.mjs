import { assertScheduledCity, scheduledSnapshotWindow, validDateOnly } from './snapshot-schedule.mjs'

export const WATCHDOG_SCHEMA_VERSION = 1
export const WATCHDOG_EVENT_SCHEMA_VERSION = 7
export const WATCHDOG_MAX_PROBE_AGE_MS = 8 * 24 * 60 * 60 * 1000
export const WATCHDOG_MAX_PROBE_WINDOW_DISTANCE = 1

export const WATCHDOG_STATUSES = Object.freeze([
  'published',
  'published_rollback_degraded',
  'unchanged_healthy',
  'unchanged_rollback_degraded',
  'failed_active_healthy',
  'failed_active_unhealthy',
  'missing',
  'record_write_failed',
  'unknown',
])

export const WATCHDOG_DIAGNOSTIC_CLASSES = Object.freeze([
  'none',
  'window_terminal_missing',
  'attempt_incomplete',
  'window_record_missing',
  'probe_record_missing',
  'probe_evidence_expired',
  'window_probe_conflict',
  'active_version_conflict',
  'rollback_unavailable',
  'record_write_failed',
  'unsupported_schema',
  'watchdog_query_failed',
  'window_failed_active_healthy',
  'active_probe_failed',
  'unknown',
])

export const WATCHDOG_SIGNAL_AGE_BUCKETS = Object.freeze([
  'same_window',
  'lt_24h',
  '1_7d',
  '7_8d',
  'expired',
  'none',
])

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const FULL_SHA = /^[a-f0-9]{40}$/

export function evaluateWindowWatchdog({
  city,
  scheduleDate,
  evaluatedAt,
  window,
  sameWindowProbe,
  latestUsableProbe,
  currentActiveVersion,
  attemptSummary = { attemptCount: 0, incompleteAttemptCount: 0 },
  recordWriteFailure = false,
}) {
  assertScheduledCity(city)
  const date = validDateOnly(scheduleDate)
  const expected = scheduledSnapshotWindow(city, date)
  const now = validIso(evaluatedAt)
  const authoritativeActive = currentActiveVersion === undefined
    ? window?.activeVersion ?? sameWindowProbe?.activeVersion ?? latestUsableProbe?.activeVersion ?? null
    : currentActiveVersion
  const base = {
    city, scheduleDate: date, windowId: expected.windowId, evaluatedAt: now,
    activeVersion: authoritativeActive,
  }

  if (recordWriteFailure) {
    return watchdogResult(base, {
      status: 'record_write_failed',
      diagnosticClass: 'record_write_failed',
      window,
      probe: sameWindowProbe,
    })
  }
  if (window && !validWindowEvidence(window, city, expected.windowId)) {
    return watchdogResult(base, { status: 'unknown', diagnosticClass: 'unsupported_schema', window })
  }
  if (sameWindowProbe && !validProbeEvidence(sameWindowProbe, city, expected.windowId)) {
    return watchdogResult(base, {
      status: 'unknown', diagnosticClass: 'unsupported_schema', window, probe: sameWindowProbe,
    })
  }
  if (latestUsableProbe && !validHistoricalProbeEvidence(latestUsableProbe, city)) {
    return watchdogResult(base, {
      status: 'unknown', diagnosticClass: 'unsupported_schema', window, probe: sameWindowProbe,
    })
  }
  if (!window) {
    return watchdogResult(base, {
      status: 'missing',
      diagnosticClass: Number(attemptSummary.incompleteAttemptCount) > 0
        ? 'attempt_incomplete'
        : 'window_terminal_missing',
      probe: usableProbeForCurrent(latestUsableProbe, authoritativeActive) ? latestUsableProbe : null,
      attemptSummary,
    })
  }

  if (typeof authoritativeActive !== 'string' || window.activeVersion !== authoritativeActive) {
    return watchdogResult(base, {
      status: 'unknown', diagnosticClass: 'active_version_conflict', window, probe: sameWindowProbe,
    })
  }

  if (sameWindowProbe && sameWindowProbe.activeVersion !== authoritativeActive) {
    return watchdogResult(base, {
      status: 'unknown', diagnosticClass: 'active_version_conflict', window, probe: sameWindowProbe,
    })
  }

  if (window.result === 'published') {
    if (!sameWindowProbe) {
      return watchdogResult(base, { status: 'unknown', diagnosticClass: 'probe_record_missing', window })
    }
    if (sameWindowProbe.activeProbeResult === 'degraded' && !sameWindowProbe.rollbackAvailable) {
      return watchdogResult(base, {
        status: 'published_rollback_degraded', diagnosticClass: 'rollback_unavailable', window, probe: sameWindowProbe,
      })
    }
    if (sameWindowProbe.activeProbeResult !== 'success') {
      return watchdogResult(base, {
        status: 'unknown', diagnosticClass: 'window_probe_conflict', window, probe: sameWindowProbe,
      })
    }
    return watchdogResult(base, { status: 'published', diagnosticClass: 'none', window, probe: sameWindowProbe })
  }

  if (window.result === 'unchanged') {
    if (!sourceCheckBelongsToWindow(window, expected.scheduledAt, now)) {
      return watchdogResult(base, { status: 'unknown', diagnosticClass: 'window_probe_conflict', window, probe: sameWindowProbe })
    }
    if (!sameWindowProbe) {
      return watchdogResult(base, { status: 'unknown', diagnosticClass: 'probe_record_missing', window })
    }
    if (!usableProbeForCurrent(sameWindowProbe, window.activeVersion)) {
      return watchdogResult(base, {
        status: sameWindowProbe.activeProbeResult === 'error' ? 'failed_active_unhealthy' : 'unknown',
        diagnosticClass: sameWindowProbe.activeProbeResult === 'error' ? 'active_probe_failed' : 'window_probe_conflict',
        window,
        probe: sameWindowProbe,
      })
    }
    return watchdogResult(base, {
      status: sameWindowProbe.rollbackAvailable ? 'unchanged_healthy' : 'unchanged_rollback_degraded',
      diagnosticClass: sameWindowProbe.rollbackAvailable ? 'none' : 'rollback_unavailable',
      window,
      probe: sameWindowProbe,
    })
  }

  if (sameWindowProbe?.activeProbeResult === 'error') {
    return watchdogResult(base, {
      status: 'failed_active_unhealthy', diagnosticClass: 'active_probe_failed', window, probe: sameWindowProbe,
    })
  }
  const candidate = usableProbeForCurrent(sameWindowProbe, authoritativeActive)
    ? sameWindowProbe
    : usableProbeForCurrent(latestUsableProbe, authoritativeActive) ? latestUsableProbe : null
  if (!candidate) {
    return watchdogResult(base, { status: 'unknown', diagnosticClass: 'probe_record_missing', window })
  }
  const freshness = probeFreshness(candidate, expected.windowId, now)
  if (!freshness.usable) {
    return watchdogResult(base, {
      status: 'unknown', diagnosticClass: 'probe_evidence_expired', window, probe: candidate,
    })
  }
  return watchdogResult(base, {
    status: 'failed_active_healthy',
    diagnosticClass: 'window_failed_active_healthy',
    window,
    probe: candidate,
  })
}

export function createWindowWatchdogEvent(result, releaseSha = null) {
  const safe = validateWatchdogResult(result)
  const successful = safe.status === 'published' || safe.status === 'unchanged_healthy'
  const degraded = safe.status === 'published_rollback_degraded'
    || safe.status === 'unchanged_rollback_degraded'
    || safe.status === 'failed_active_healthy'
  return Object.freeze({
    eventSchema: WATCHDOG_EVENT_SCHEMA_VERSION,
    event: 'window_watchdog_completed',
    releaseSha: releaseSha && FULL_SHA.test(releaseSha) ? releaseSha : null,
    workerVersionId: null,
    workerCreatedAt: null,
    deploymentId: null,
    city: safe.city,
    operation: 'window_watchdog',
    result: successful ? 'success' : degraded ? 'degraded' : 'error',
    source: safe.windowResult === null ? 'none' : 'snapshot',
    snapshotVersion: safe.activeVersion,
    httpStatusClass: 'none',
    latencyBucket: safe.latencyBucket,
    cacheResult: 'not_applicable',
    trafficClass: 'synthetic',
    sampleProbability: 1,
    failureClass: safe.diagnosticClass,
    emptyReason: 'not_applicable',
    qualityBucket: 'not_applicable',
    windowId: safe.windowId,
    windowResult: safe.windowResult ?? 'none',
    watchdogStatus: safe.status,
    probeResult: safe.probeResult,
    rollbackAvailable: safe.rollbackAvailable,
    signalAgeBucket: safe.signalAgeBucket,
    probeWindowDistance: safe.probeWindowDistance,
  })
}

export function watchdogFailureResult({ city, scheduleDate, evaluatedAt, diagnosticClass }) {
  assertScheduledCity(city)
  const expected = scheduledSnapshotWindow(city, scheduleDate)
  return watchdogResult({
    city,
    scheduleDate,
    windowId: expected.windowId,
    evaluatedAt: validIso(evaluatedAt),
  }, {
    status: diagnosticClass === 'record_write_failed' ? 'record_write_failed' : 'unknown',
    diagnosticClass: WATCHDOG_DIAGNOSTIC_CLASSES.includes(diagnosticClass) ? diagnosticClass : 'unknown',
  })
}

export function withWatchdogLatency(result, milliseconds) {
  return validateWatchdogResult({ ...result, latencyBucket: latencyBucket(milliseconds) })
}

export function validateWatchdogResult(value) {
  if (!value || typeof value !== 'object') throw new Error('Invalid watchdog result')
  assertScheduledCity(value.city)
  if (!WATCHDOG_STATUSES.includes(value.status)) throw new Error('Invalid watchdog status')
  if (!WATCHDOG_DIAGNOSTIC_CLASSES.includes(value.diagnosticClass)) throw new Error('Invalid watchdog diagnostic')
  if (!WATCHDOG_SIGNAL_AGE_BUCKETS.includes(value.signalAgeBucket)) throw new Error('Invalid watchdog signal age')
  if (!WATCHDOG_SIGNAL_AGE_BUCKETS.includes(value.sourceCheckAgeBucket)) throw new Error('Invalid watchdog source age')
  if (!(value.windowResult === null || ['published', 'unchanged', 'failed'].includes(value.windowResult))) {
    throw new Error('Invalid watchdog window result')
  }
  if (!['success', 'degraded', 'error', 'missing', 'expired'].includes(value.probeResult)) {
    throw new Error('Invalid watchdog probe result')
  }
  if (!(value.rollbackAvailable === null || typeof value.rollbackAvailable === 'boolean')) {
    throw new Error('Invalid watchdog rollback status')
  }
  if (!(value.probeWindowDistance === null
    || (Number.isInteger(value.probeWindowDistance) && value.probeWindowDistance >= 0 && value.probeWindowDistance <= 52))) {
    throw new Error('Invalid watchdog probe distance')
  }
  return Object.freeze({
    watchdogSchemaVersion: WATCHDOG_SCHEMA_VERSION,
    city: value.city,
    scheduleDate: validDateOnly(value.scheduleDate),
    windowId: safeIdentifier(value.windowId),
    evaluatedAt: validIso(value.evaluatedAt),
    status: value.status,
    activeVersion: nullableIdentifier(value.activeVersion),
    windowResult: value.windowResult,
    probeResult: value.probeResult,
    rollbackAvailable: value.rollbackAvailable,
    signalAgeBucket: value.signalAgeBucket,
    sourceCheckAgeBucket: value.sourceCheckAgeBucket,
    probeWindowDistance: value.probeWindowDistance,
    diagnosticClass: value.diagnosticClass,
    sourceRecordVersion: safeIdentifier(value.sourceRecordVersion),
    lastSourceCheckAt: nullableIso(value.lastSourceCheckAt),
    activeProbeAt: nullableIso(value.activeProbeAt),
    latencyBucket: safeIdentifier(value.latencyBucket),
  })
}

function watchdogResult(base, { status, diagnosticClass, window = null, probe = null }) {
  const freshness = probe ? probeFreshness(probe, base.windowId, base.evaluatedAt) : null
  const sourceCheckAge = window?.lastSourceCheckAt
    ? ageBucket(Date.parse(base.evaluatedAt) - Date.parse(window.lastSourceCheckAt), true)
    : 'none'
  return validateWatchdogResult({
    ...base,
    status,
    activeVersion: base.activeVersion ?? null,
    windowResult: window?.result ?? null,
    probeResult: probe?.activeProbeResult ?? 'missing',
    rollbackAvailable: probe ? probe.rollbackAvailable === true : null,
    signalAgeBucket: freshness?.ageBucket ?? 'none',
    sourceCheckAgeBucket: sourceCheckAge,
    probeWindowDistance: freshness?.windowDistance ?? null,
    diagnosticClass,
    sourceRecordVersion: `window${window?.schemaVersion ?? 0}_probe${probe?.probeSchemaVersion ?? 0}`,
    lastSourceCheckAt: window?.lastSourceCheckAt ?? null,
    activeProbeAt: probe?.activeProbeAt ?? null,
    latencyBucket: 'unknown',
  })
}

function validWindowEvidence(value, city, windowId) {
  return value?.schemaVersion === 1
    && value.city === city
    && value.windowId === windowId
    && ['published', 'unchanged', 'failed'].includes(value.result)
    && (value.activeVersion === null || typeof value.activeVersion === 'string')
}

function validProbeEvidence(value, city, windowId) {
  return value?.probeSchemaVersion === 1
    && value.city === city
    && value.windowId === windowId
    && ['success', 'degraded', 'error'].includes(value.activeProbeResult)
    && typeof value.activeProbeAt === 'string'
    && !Number.isNaN(Date.parse(value.activeProbeAt))
}

function validHistoricalProbeEvidence(value, city) {
  return validProbeEvidence(value, city, value?.windowId) && parseWindowDate(value.windowId)?.city === city
}

function usableProbeForCurrent(probe, activeVersion) {
  return Boolean(probe
    && (probe.activeProbeResult === 'success' || probe.activeProbeResult === 'degraded')
    && (activeVersion === null || probe.activeVersion === activeVersion))
}

function sourceCheckBelongsToWindow(window, scheduledAt, evaluatedAt) {
  const source = Date.parse(window.lastSourceCheckAt)
  return Number.isFinite(source) && source >= Date.parse(scheduledAt) && source <= Date.parse(evaluatedAt)
}

function probeFreshness(probe, expectedWindowId, evaluatedAt) {
  const age = Date.parse(evaluatedAt) - Date.parse(probe.activeProbeAt)
  const windowDistance = snapshotWindowDistance(probe.windowId, expectedWindowId)
  const usable = age >= 0
    && age <= WATCHDOG_MAX_PROBE_AGE_MS
    && windowDistance !== null
    && windowDistance <= WATCHDOG_MAX_PROBE_WINDOW_DISTANCE
  return {
    usable,
    ageBucket: !Number.isFinite(age) || age < 0 ? 'none'
      : age > WATCHDOG_MAX_PROBE_AGE_MS ? 'expired'
        : probe.windowId === expectedWindowId ? 'same_window' : ageBucket(age, true),
    windowDistance,
  }
}

function snapshotWindowDistance(from, to) {
  const first = parseWindowDate(from)
  const second = parseWindowDate(to)
  if (!first || !second || first.city !== second.city) return null
  const days = Math.abs(Date.parse(`${second.date}T00:00:00.000Z`) - Date.parse(`${first.date}T00:00:00.000Z`)) / 86_400_000
  return Number.isInteger(days / 7) ? days / 7 : null
}

function parseWindowDate(value) {
  const match = /^v1:([A-Za-z0-9]+):(\d{4}-\d{2}-\d{2}):0317$/.exec(String(value))
  return match ? { city: match[1], date: match[2] } : null
}

function ageBucket(milliseconds, expire) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'none'
  if (expire && milliseconds > WATCHDOG_MAX_PROBE_AGE_MS) return 'expired'
  if (milliseconds < 24 * 60 * 60 * 1000) return 'lt_24h'
  if (milliseconds <= 7 * 24 * 60 * 60 * 1000) return '1_7d'
  return '7_8d'
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

function validIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw new Error('Invalid watchdog time')
  return new Date(value).toISOString()
}

function nullableIso(value) {
  return value === null || value === undefined ? null : validIso(value)
}

function safeIdentifier(value) {
  const text = String(value)
  if (!SAFE_IDENTIFIER.test(text)) throw new Error('Invalid watchdog identifier')
  return text
}

function nullableIdentifier(value) {
  return value === null || value === undefined || value === '' ? null : safeIdentifier(value)
}
