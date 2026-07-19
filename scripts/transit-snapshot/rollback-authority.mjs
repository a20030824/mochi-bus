const SAFE_SNAPSHOT_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

export function resolveRollbackAuthority({ city, state, d1ActiveVersion }) {
  if (typeof city !== 'string' || city.length === 0) {
    throw new Error('Rollback city is required')
  }
  if (typeof d1ActiveVersion !== 'string' || !SAFE_SNAPSHOT_VERSION.test(d1ActiveVersion)) {
    throw new Error(`D1 has no valid active snapshot for ${city}`)
  }
  if (typeof state?.version !== 'string' || !SAFE_SNAPSHOT_VERSION.test(state.version)) {
    throw new Error(`No valid published snapshot state found for ${city}`)
  }
  if (state.version !== d1ActiveVersion) {
    throw new Error(`Rollback authority mismatch for ${city}; reconcile R2 state with D1 before retrying`)
  }
  return d1ActiveVersion
}
