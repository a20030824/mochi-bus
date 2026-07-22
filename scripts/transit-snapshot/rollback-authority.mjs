const SAFE_SNAPSHOT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CORE_COUNT_FIELDS = Object.freeze(['routes', 'patterns', 'stops', 'places', 'patternStops'])
const INTEGRITY_FIELDS = Object.freeze(['dangling', 'shortPatterns', 'orphanRoutes', 'placeMismatches'])

export class SnapshotAuthorityError extends Error {
  constructor(code) {
    super('Snapshot authority contract failed')
    this.name = 'SnapshotAuthorityError'
    this.code = code
  }
}

export function isSafeSnapshotVersion(value) {
  return typeof value === 'string' && SAFE_SNAPSHOT_VERSION.test(value)
}

export function resolveRollbackAuthority({ city, state, d1ActiveVersion }) {
  if (typeof city !== 'string' || city.length === 0) throw authorityFailure('active_pointer_invalid')
  if (!isSafeSnapshotVersion(d1ActiveVersion)) throw authorityFailure('active_pointer_invalid')
  if (!validStatePointer(state)) throw authorityFailure('state_invalid')
  if (state.version !== d1ActiveVersion) throw authorityFailure('authority_mismatch')
  return d1ActiveVersion
}

export function resolveRollbackTarget({ activeVersion, state, explicitTarget }) {
  if (!isSafeSnapshotVersion(activeVersion)) throw authorityFailure('active_pointer_invalid')
  const target = explicitTarget ?? state?.previousVersion
  if (!isSafeSnapshotVersion(target) || target === activeVersion) {
    throw authorityFailure('rollback_target_invalid')
  }
  return target
}

export function resolveReconcilePrevious({ activeVersion, state, explicitPrevious }) {
  if (!isSafeSnapshotVersion(activeVersion)) throw authorityFailure('active_pointer_invalid')
  if (explicitPrevious !== undefined && explicitPrevious !== null && explicitPrevious !== '') {
    if (!isSafeSnapshotVersion(explicitPrevious) || explicitPrevious === activeVersion) {
      throw authorityFailure('reconcile_previous_required')
    }
    return explicitPrevious
  }
  if (validStatePointer(state)
    && state.version === activeVersion
    && isSafeSnapshotVersion(state.previousVersion)
    && state.previousVersion !== activeVersion) {
    return state.previousVersion
  }
  throw authorityFailure('reconcile_previous_required')
}

export function assertSnapshotEvidence(value) {
  if (!value || typeof value !== 'object'
    || typeof value.city !== 'string' || value.city.length === 0
    || !isSafeSnapshotVersion(value.version)) {
    throw authorityFailure('target_validation_failed')
  }
  const counts = normalizeCounts(value.counts)
  const integrity = normalizeIntegrity(value.integrity)
  const manifest = value.manifest
  const prefix = `snapshots/${value.version}/cities/${value.city}/`
  if (!manifest || manifest.schemaVersion !== 2 || manifest.city !== value.city || manifest.version !== value.version
    || !sameCoreCounts(manifest.counts, counts)
    || !hasArtifactClasses(manifest.artifacts, prefix)
    || value.networkVerified !== true
    || value.sampleArtifactsVerified !== true) {
    throw authorityFailure('target_validation_failed')
  }
  return Object.freeze({
    city: value.city,
    version: value.version,
    counts: Object.freeze(counts),
    integrity: Object.freeze(integrity),
    manifest: Object.freeze({ ...manifest, artifacts: Object.freeze([...manifest.artifacts]) }),
    networkVerified: true,
    sampleArtifactsVerified: true,
  })
}

export function buildRollbackState({ currentVersion, targetVersion, evidence, at }) {
  const safe = assertEvidenceIdentity(evidence, targetVersion)
  const timestamp = validIso(at)
  return Object.freeze({
    ...metadataState(targetVersion, currentVersion, safe, timestamp),
    rollback: Object.freeze({ from: currentVersion, at: timestamp }),
  })
}

export function buildReconciledState({ activeVersion, previousVersion, evidence, importedAt, existingState }) {
  const safe = assertEvidenceIdentity(evidence, activeVersion)
  if (!isSafeSnapshotVersion(previousVersion) || previousVersion === activeVersion) {
    throw authorityFailure('reconcile_previous_required')
  }
  const authoritativePublishedAt = validIso(importedAt)
  const publishedAt = validStatePointer(existingState) && existingState.version === activeVersion
    ? nullableIso(existingState.publishedAt) ?? authoritativePublishedAt
    : authoritativePublishedAt
  return Object.freeze(metadataState(activeVersion, previousVersion, safe, publishedAt))
}

export function sameSnapshotState(actual, expected) {
  if (!actual || !expected) return false
  return JSON.stringify(stateProjection(actual)) === JSON.stringify(stateProjection(expected))
}

function metadataState(activeVersion, previousVersion, evidence, publishedAt) {
  const manifest = evidence.manifest
  return {
    schemaVersion: 2,
    contentHash: typeof manifest.contentHash === 'string' ? manifest.contentHash : null,
    version: activeVersion,
    previousVersion,
    manifestKey: `snapshots/${activeVersion}/cities/${evidence.city}/manifest.json`,
    counts: evidence.counts,
    quality: manifest.quality && typeof manifest.quality === 'object' ? manifest.quality : null,
    generatedAt: nullableIso(manifest.generatedAt),
    publishedAt,
    source: typeof manifest.source === 'string' ? manifest.source : 'TDX',
    workflowRun: manifest.workflowRun === null || manifest.workflowRun === undefined
      ? null : String(manifest.workflowRun),
  }
}

function assertEvidenceIdentity(evidence, version) {
  const safe = assertSnapshotEvidence(evidence)
  if (!isSafeSnapshotVersion(version) || safe.version !== version) {
    throw authorityFailure('target_validation_failed')
  }
  return safe
}

function normalizeCounts(value) {
  if (!value || typeof value !== 'object') throw authorityFailure('target_validation_failed')
  const result = {}
  for (const field of CORE_COUNT_FIELDS) {
    const count = Number(value[field])
    if (!Number.isSafeInteger(count) || count < 1) throw authorityFailure('target_validation_failed')
    result[field] = count
  }
  return result
}

function normalizeIntegrity(value) {
  if (!value || typeof value !== 'object') throw authorityFailure('target_validation_failed')
  const result = {}
  for (const field of INTEGRITY_FIELDS) {
    const count = Number(value[field])
    if (!Number.isSafeInteger(count) || count !== 0) throw authorityFailure('target_validation_failed')
    result[field] = count
  }
  return result
}

function sameCoreCounts(actual, expected) {
  return Boolean(actual) && CORE_COUNT_FIELDS.every((field) => Number(actual[field]) === expected[field])
}

function hasArtifactClasses(artifacts, prefix) {
  return Array.isArray(artifacts)
    && artifacts.some((item) => item?.key === `${prefix}network.json`)
    && artifacts.some((item) => item?.key?.startsWith(`${prefix}shapes/`))
    && artifacts.some((item) => item?.key?.startsWith(`${prefix}schedules/`))
    && artifacts.some((item) => item?.key?.startsWith(`${prefix}places/`))
}

function validStatePointer(state) {
  return Boolean(state && state.schemaVersion === 2 && isSafeSnapshotVersion(state.version))
}

function validIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) throw authorityFailure('target_validation_failed')
  return new Date(value).toISOString()
}

function nullableIso(value) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) return null
  return new Date(value).toISOString()
}

function stateProjection(value) {
  return {
    schemaVersion: value.schemaVersion,
    contentHash: value.contentHash ?? null,
    version: value.version,
    previousVersion: value.previousVersion,
    manifestKey: value.manifestKey ?? null,
    counts: value.counts ?? null,
    quality: value.quality ?? null,
    generatedAt: value.generatedAt ?? null,
    publishedAt: value.publishedAt ?? null,
    source: value.source ?? null,
    workflowRun: value.workflowRun ?? null,
  }
}

function authorityFailure(code) {
  return new SnapshotAuthorityError(code)
}
