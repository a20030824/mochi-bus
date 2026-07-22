import {
  assertSnapshotEvidence,
  buildReconciledState,
  buildRollbackState,
  isSafeSnapshotVersion,
  resolveReconcilePrevious,
  resolveRollbackAuthority,
  resolveRollbackTarget,
  sameSnapshotState,
} from './rollback-authority.mjs'

const OPERATION_CODES = new Set([
  'active_pointer_invalid',
  'state_invalid',
  'authority_mismatch',
  'rollback_target_invalid',
  'target_validation_failed',
  'activation_conflict',
  'smoke_failed_restored',
  'restore_failed',
  'state_write_failed_reconcile_required',
  'reconcile_previous_required',
  'reconcile_failed',
])

export class SnapshotOperationError extends Error {
  constructor(code, fields = {}) {
    super('Snapshot operation failed')
    this.name = 'SnapshotOperationError'
    this.code = OPERATION_CODES.has(code) ? code : 'reconcile_failed'
    this.city = safeField(fields.city)
    this.activeVersion = safeVersionField(fields.activeVersion)
    this.previousVersion = safeVersionField(fields.previousVersion)
    this.targetVersion = safeVersionField(fields.targetVersion)
  }
}

export async function executeRollback(options) {
  const city = options.city
  const authority = await readAuthority(options, city)
  const state = await readStateForRollback(options, city)
  const currentVersion = resolveRollbackAuthority({
    city, state, d1ActiveVersion: authority.activeVersion,
  })
  const targetVersion = resolveRollbackTarget({
    activeVersion: currentVersion,
    state,
    explicitTarget: options.targetVersion,
  })
  const evidence = await validateVersion(options, targetVersion, city)
  const activated = await guardedTransition(options, city, currentVersion, targetVersion)
  if (!activated) {
    throw operationFailure('activation_conflict', { city, activeVersion: currentVersion, targetVersion })
  }

  try {
    await options.smoke({ city, version: targetVersion, evidence })
  } catch {
    let restored = false
    try {
      restored = await options.transition({
        city, expectedVersion: targetVersion, targetVersion: currentVersion,
      }) === true
    } catch {
      restored = false
    }
    if (!restored) {
      throw operationFailure('restore_failed', {
        city, activeVersion: targetVersion, previousVersion: currentVersion, targetVersion,
      })
    }
    throw operationFailure('smoke_failed_restored', {
      city, activeVersion: currentVersion, previousVersion: targetVersion, targetVersion,
    })
  }

  const confirmed = await readAuthority(options, city)
  if (confirmed.activeVersion !== targetVersion) {
    throw operationFailure('activation_conflict', { city, activeVersion: confirmed.activeVersion, targetVersion })
  }

  const nextState = buildRollbackState({
    currentVersion,
    targetVersion,
    evidence,
    at: (options.now ?? (() => new Date()))().toISOString(),
  })
  try {
    await options.writeState(nextState)
  } catch {
    throw operationFailure('state_write_failed_reconcile_required', {
      city, activeVersion: targetVersion, previousVersion: currentVersion, targetVersion,
    })
  }
  return Object.freeze({
    operation: 'rollback', outcome: 'rolled_back', city,
    activeVersion: targetVersion, previousVersion: currentVersion,
  })
}

export async function executeReconcile(options) {
  const city = options.city
  const authority = await readAuthority(options, city)
  const activeVersion = authority.activeVersion
  if (!isSafeSnapshotVersion(activeVersion)) {
    throw operationFailure('active_pointer_invalid', { city })
  }
  let state
  try {
    state = await options.readState()
  } catch {
    throw operationFailure('reconcile_failed', { city, activeVersion })
  }
  const previousVersion = resolveReconcilePrevious({
    activeVersion,
    state,
    explicitPrevious: options.explicitPrevious,
  })
  const activeEvidence = await validateVersion(options, activeVersion, city)
  await validateVersion(options, previousVersion, city)
  const nextState = buildReconciledState({
    activeVersion,
    previousVersion,
    evidence: activeEvidence,
    importedAt: authority.importedAt,
    existingState: state,
  })
  const confirmed = await readAuthority(options, city)
  if (confirmed.activeVersion !== activeVersion) {
    throw operationFailure('authority_mismatch', { city, activeVersion: confirmed.activeVersion, previousVersion })
  }
  if (sameSnapshotState(state, nextState)) {
    return Object.freeze({
      operation: 'reconcile', outcome: 'already_reconciled', city,
      activeVersion, previousVersion,
    })
  }
  try {
    await options.writeState(nextState)
  } catch {
    throw operationFailure('reconcile_failed', { city, activeVersion, previousVersion })
  }
  return Object.freeze({
    operation: 'reconcile', outcome: 'reconciled', city,
    activeVersion, previousVersion,
  })
}

export function safeOperationDiagnostic(error, operation, city) {
  const code = error instanceof SnapshotOperationError || OPERATION_CODES.has(error?.code)
    ? error.code : 'reconcile_failed'
  return Object.freeze({
    event: 'snapshot_authority_operation',
    operation: operation === 'rollback' ? 'rollback' : 'reconcile',
    city: safeField(city),
    outcome: code,
    activeVersion: safeVersionField(error?.activeVersion),
    previousVersion: safeVersionField(error?.previousVersion),
    targetVersion: safeVersionField(error?.targetVersion),
  })
}

async function readAuthority(options, city) {
  let authority
  try {
    authority = await options.readAuthority()
  } catch {
    throw operationFailure('active_pointer_invalid', { city })
  }
  if (!isSafeSnapshotVersion(authority?.activeVersion)) {
    throw operationFailure('active_pointer_invalid', { city })
  }
  return authority
}

async function readStateForRollback(options, city) {
  try {
    const state = await options.readState()
    if (!state) throw operationFailure('state_invalid', { city })
    return state
  } catch (error) {
    if (error instanceof SnapshotOperationError) throw error
    throw operationFailure('state_invalid', { city })
  }
}

async function validateVersion(options, version, city) {
  try {
    return assertSnapshotEvidence(await options.validateVersion(version))
  } catch (error) {
    if (OPERATION_CODES.has(error?.code)) throw operationFailure(error.code, { city, targetVersion: version })
    throw operationFailure('target_validation_failed', { city, targetVersion: version })
  }
}

async function guardedTransition(options, city, expectedVersion, targetVersion) {
  try {
    return await options.transition({ city, expectedVersion, targetVersion }) === true
  } catch {
    return false
  }
}

function safeField(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) ? value : null
}

function safeVersionField(value) {
  return isSafeSnapshotVersion(value) ? value : null
}

function operationFailure(code, fields) {
  return new SnapshotOperationError(code, fields)
}
