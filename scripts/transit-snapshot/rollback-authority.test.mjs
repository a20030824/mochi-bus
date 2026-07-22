import { describe, expect, it } from 'vitest'
import {
  assertSnapshotEvidence,
  buildReconciledState,
  buildRollbackState,
  resolveReconcilePrevious,
  resolveRollbackAuthority,
  resolveRollbackTarget,
  sameSnapshotState,
} from './rollback-authority.mjs'

const counts = { routes: 2, patterns: 2, stops: 4, places: 3, patternStops: 4 }
const integrity = { dangling: 0, shortPatterns: 0, orphanRoutes: 0, placeMismatches: 0 }
const artifacts = [
  { key: 'snapshots/v1/cities/Taipei/network.json', bytes: 10, sha256: 'a'.repeat(64), contentType: 'application/json' },
  { key: 'snapshots/v1/cities/Taipei/shapes/p1.json', bytes: 10, sha256: 'b'.repeat(64), contentType: 'application/geo+json' },
  { key: 'snapshots/v1/cities/Taipei/schedules/r1.json', bytes: 10, sha256: 'c'.repeat(64), contentType: 'application/json' },
  { key: 'snapshots/v1/cities/Taipei/places/x1.json', bytes: 10, sha256: 'd'.repeat(64), contentType: 'application/json' },
]
const manifest = {
  schemaVersion: 2,
  city: 'Taipei',
  version: 'v1',
  contentHash: 'hash-v1',
  generatedAt: '2026-07-20T00:00:00.000Z',
  source: 'TDX',
  workflowRun: '123',
  counts,
  quality: { scheduleCoverage: 1 },
  artifacts,
}

function evidence(overrides = {}) {
  return {
    city: 'Taipei', version: 'v1', counts, integrity, manifest,
    networkVerified: true, sampleArtifactsVerified: true,
    ...overrides,
  }
}

describe('snapshot rollback authority', () => {
  it('uses the D1 active pointer only when R2 state agrees', () => {
    expect(resolveRollbackAuthority({
      city: 'Taipei', state: { schemaVersion: 2, version: 'v1' }, d1ActiveVersion: 'v1',
    })).toBe('v1')
  })

  it('fails closed for missing D1 authority, invalid state, and divergence', () => {
    expect(() => resolveRollbackAuthority({ city: 'Taipei', state: { schemaVersion: 2, version: 'v1' }, d1ActiveVersion: null }))
      .toThrowError(expect.objectContaining({ code: 'active_pointer_invalid' }))
    expect(() => resolveRollbackAuthority({ city: 'Taipei', state: null, d1ActiveVersion: 'v1' }))
      .toThrowError(expect.objectContaining({ code: 'state_invalid' }))
    expect(() => resolveRollbackAuthority({ city: 'Taipei', state: { schemaVersion: 1, version: 'v1' }, d1ActiveVersion: 'v1' }))
      .toThrowError(expect.objectContaining({ code: 'state_invalid' }))
    expect(() => resolveRollbackAuthority({ city: 'Taipei', state: { schemaVersion: 2, version: 'v0' }, d1ActiveVersion: 'v1' }))
      .toThrowError(expect.objectContaining({ code: 'authority_mismatch' }))
  })

  it('applies the same target rules to explicit and default previous versions', () => {
    expect(resolveRollbackTarget({ activeVersion: 'v2', state: { previousVersion: 'v1' } })).toBe('v1')
    expect(resolveRollbackTarget({ activeVersion: 'v2', state: { previousVersion: 'v0' }, explicitTarget: 'v1' })).toBe('v1')
    expect(() => resolveRollbackTarget({ activeVersion: 'v2', state: {} }))
      .toThrowError(expect.objectContaining({ code: 'rollback_target_invalid' }))
    expect(() => resolveRollbackTarget({ activeVersion: 'v2', state: { previousVersion: 'v2' } }))
      .toThrowError(expect.objectContaining({ code: 'rollback_target_invalid' }))
  })

  it('never guesses reconcile previous from divergent or invalid state', () => {
    expect(resolveReconcilePrevious({
      activeVersion: 'v2', state: { schemaVersion: 2, version: 'v2', previousVersion: 'v1' },
    })).toBe('v1')
    expect(resolveReconcilePrevious({ activeVersion: 'v2', state: null, explicitPrevious: 'v1' })).toBe('v1')
    expect(() => resolveReconcilePrevious({
      activeVersion: 'v2', state: { schemaVersion: 2, version: 'v1', previousVersion: 'v0' },
    })).toThrowError(expect.objectContaining({ code: 'reconcile_previous_required' }))
  })
})

describe('snapshot rollback evidence', () => {
  it('accepts complete D1, manifest, network, and exact artifact evidence', () => {
    expect(assertSnapshotEvidence(evidence())).toMatchObject({ city: 'Taipei', version: 'v1', counts })
  })

  it('rejects incomplete rows and relational integrity failures', () => {
    expect(() => assertSnapshotEvidence(evidence({ counts: { ...counts, places: 0 } })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
    expect(() => assertSnapshotEvidence(evidence({ integrity: { ...integrity, shortPatterns: 1 } })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
  })

  it('rejects manifest identity/count/artifact-class failures', () => {
    expect(() => assertSnapshotEvidence(evidence({ manifest: { ...manifest, version: 'v0' } })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
    expect(() => assertSnapshotEvidence(evidence({ manifest: { ...manifest, counts: { ...counts, routes: 3 } } })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
    expect(() => assertSnapshotEvidence(evidence({ manifest: { ...manifest, artifacts: artifacts.slice(0, 3) } })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
  })

  it('rejects bad network metadata or corrupt exact artifacts', () => {
    expect(() => assertSnapshotEvidence(evidence({ networkVerified: false })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
    expect(() => assertSnapshotEvidence(evidence({ sampleArtifactsVerified: false })))
      .toThrowError(expect.objectContaining({ code: 'target_validation_failed' }))
  })
})

describe('snapshot state planning', () => {
  it('swaps active and previous after rollback', () => {
    const next = buildRollbackState({
      currentVersion: 'v2', targetVersion: 'v1', evidence: assertSnapshotEvidence(evidence()),
      at: '2026-07-22T00:00:00.000Z',
    })
    expect(next).toMatchObject({ schemaVersion: 2, version: 'v1', previousVersion: 'v2', rollback: { from: 'v2' } })
  })

  it('builds an idempotent reconcile state without changing authority', () => {
    const value = {
      activeVersion: 'v1', previousVersion: 'v0', evidence: assertSnapshotEvidence(evidence()),
      importedAt: '2026-07-20T00:00:00.000Z', existingState: null,
    }
    const first = buildReconciledState(value)
    const second = buildReconciledState(value)
    expect(second).toEqual(first)
    expect(first).toMatchObject({ version: 'v1', previousVersion: 'v0', publishedAt: '2026-07-20T00:00:00.000Z' })
    expect(sameSnapshotState(first, second)).toBe(true)
  })
})
