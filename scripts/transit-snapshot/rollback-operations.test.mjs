import { describe, expect, it, vi } from 'vitest'
import { executeReconcile, executeRollback, safeOperationDiagnostic } from './rollback-operations.mjs'

const manifest = {
  schemaVersion: 2, city: 'Taipei', version: 'v1', contentHash: 'hash-v1',
  generatedAt: '2026-07-20T00:00:00.000Z', source: 'TDX', workflowRun: null,
  counts: { routes: 2, patterns: 2, stops: 4, places: 3, patternStops: 4 },
  quality: {},
  artifacts: [
    { key: 'snapshots/v1/cities/Taipei/network.json' },
    { key: 'snapshots/v1/cities/Taipei/shapes/p1.json' },
    { key: 'snapshots/v1/cities/Taipei/schedules/r1.json' },
    { key: 'snapshots/v1/cities/Taipei/places/x1.json' },
  ],
}
const complete = {
  city: 'Taipei', version: 'v1', manifest,
  counts: manifest.counts,
  integrity: { dangling: 0, shortPatterns: 0, orphanRoutes: 0, placeMismatches: 0 },
  networkVerified: true, sampleArtifactsVerified: true,
}

function validated(version) {
  const prefix = `snapshots/${version}/cities/Taipei/`
  return {
    ...complete, version,
    manifest: {
      ...manifest, version,
      artifacts: [
        { key: `${prefix}network.json` },
        { key: `${prefix}shapes/p1.json` },
        { key: `${prefix}schedules/r1.json` },
        { key: `${prefix}places/x1.json` },
      ],
    },
  }
}

function rollbackHarness(overrides = {}) {
  const calls = []
  let activeVersion = 'v2'
  const state = { schemaVersion: 2, version: 'v2', previousVersion: 'v1' }
  const transition = vi.fn(async ({ expectedVersion, targetVersion }) => {
    calls.push(`transition:${expectedVersion}->${targetVersion}`)
    if (activeVersion !== expectedVersion) return false
    activeVersion = targetVersion
    return true
  })
  return {
    calls,
    options: {
      city: 'Taipei',
      readAuthority: vi.fn(async () => ({ activeVersion, importedAt: '2026-07-21T00:00:00.000Z' })),
      readState: vi.fn(async () => state),
      validateVersion: vi.fn(async (version) => validated(version)),
      transition,
      smoke: vi.fn(async ({ version }) => { calls.push(`smoke:${version}`) }),
      writeState: vi.fn(async (value) => { calls.push(`write:${value.version}`) }),
      now: () => new Date('2026-07-22T00:00:00.000Z'),
      ...overrides,
    },
  }
}

describe('executeRollback', () => {
  it('rolls back only after validating authority and the target', async () => {
    const { calls, options } = rollbackHarness()
    const outcome = await executeRollback(options)
    expect(outcome).toMatchObject({ outcome: 'rolled_back', activeVersion: 'v1', previousVersion: 'v2' })
    expect(calls).toEqual(['transition:v2->v1', 'smoke:v1', 'write:v1'])
    expect(options.validateVersion).toHaveBeenCalledWith('v1')
  })

  it('fails before mutation when D1 and R2 authority diverge', async () => {
    const { options } = rollbackHarness({ readState: vi.fn(async () => ({ schemaVersion: 2, version: 'v0', previousVersion: 'v1' })) })
    await expect(executeRollback(options)).rejects.toMatchObject({ code: 'authority_mismatch' })
    expect(options.transition).not.toHaveBeenCalled()
  })

  it('fails closed when D1 has no active pointer or state is missing', async () => {
    const missingActive = rollbackHarness({ readAuthority: vi.fn(async () => ({ activeVersion: null, importedAt: null })) }).options
    await expect(executeRollback(missingActive)).rejects.toMatchObject({ code: 'active_pointer_invalid' })
    const missingState = rollbackHarness({ readState: vi.fn(async () => null) }).options
    await expect(executeRollback(missingState)).rejects.toMatchObject({ code: 'state_invalid' })
  })

  it('rejects an invalid target before activation', async () => {
    const validateVersion = vi.fn(async () => { throw Object.assign(new Error('bounded'), { code: 'target_validation_failed' }) })
    const { options } = rollbackHarness({ validateVersion })
    await expect(executeRollback(options)).rejects.toMatchObject({ code: 'target_validation_failed' })
    expect(options.transition).not.toHaveBeenCalled()
  })

  it('detects an optimistic activation conflict', async () => {
    const { options } = rollbackHarness({ transition: vi.fn(async () => false) })
    await expect(executeRollback(options)).rejects.toMatchObject({ code: 'activation_conflict' })
    expect(options.smoke).not.toHaveBeenCalled()
  })

  it('restores the original pointer when smoke fails', async () => {
    const { calls, options } = rollbackHarness({ smoke: vi.fn(async () => { throw new Error('raw secret URL') }) })
    await expect(executeRollback(options)).rejects.toMatchObject({ code: 'smoke_failed_restored' })
    expect(calls).toEqual(['transition:v2->v1', 'transition:v1->v2'])
    expect(options.writeState).not.toHaveBeenCalled()
  })

  it('raises a distinct authority failure when restoring fails', async () => {
    const transition = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const { options } = rollbackHarness({ transition, smoke: vi.fn(async () => { throw new Error('failed') }) })
    await expect(executeRollback(options)).rejects.toMatchObject({ code: 'restore_failed' })
  })

  it('keeps the healthy D1 target and requires reconcile when state write fails', async () => {
    const { options } = rollbackHarness({ writeState: vi.fn(async () => { throw new Error('raw response') }) })
    await expect(executeRollback(options)).rejects.toMatchObject({
      code: 'state_write_failed_reconcile_required', activeVersion: 'v1', previousVersion: 'v2',
    })
    expect(options.transition).toHaveBeenCalledTimes(1)
  })

  it('validates explicit and default targets through the same gate', async () => {
    const { options } = rollbackHarness({ targetVersion: 'v0' })
    await executeRollback(options)
    expect(options.validateVersion).toHaveBeenCalledWith('v0')
  })
})

describe('executeReconcile', () => {
  function reconcileHarness(overrides = {}) {
    const current = { schemaVersion: 2, version: 'v2', previousVersion: 'v1' }
    return {
      city: 'Taipei',
      readAuthority: vi.fn(async () => ({ activeVersion: 'v2', importedAt: '2026-07-21T00:00:00.000Z' })),
      readState: vi.fn(async () => current),
      validateVersion: vi.fn(async (version) => validated(version)),
      writeState: vi.fn(async () => undefined),
      ...overrides,
    }
  }

  it('never changes D1 and writes only after active and previous validate', async () => {
    const options = reconcileHarness({ explicitPrevious: 'v1' })
    const outcome = await executeReconcile(options)
    expect(outcome).toMatchObject({ outcome: 'reconciled', activeVersion: 'v2', previousVersion: 'v1' })
    expect(options.validateVersion).toHaveBeenNthCalledWith(1, 'v2')
    expect(options.validateVersion).toHaveBeenNthCalledWith(2, 'v1')
    expect(options.writeState).toHaveBeenCalledTimes(1)
    expect(options).not.toHaveProperty('transition')
  })

  it('does not write when active validation fails', async () => {
    const options = reconcileHarness({
      explicitPrevious: 'v1',
      validateVersion: vi.fn(async () => { throw Object.assign(new Error('bounded'), { code: 'target_validation_failed' }) }),
    })
    await expect(executeReconcile(options)).rejects.toMatchObject({ code: 'target_validation_failed' })
    expect(options.writeState).not.toHaveBeenCalled()
  })

  it('requires an explicit previous when stale state cannot be trusted', async () => {
    const options = reconcileHarness({ readState: vi.fn(async () => ({ schemaVersion: 2, version: 'v0', previousVersion: 'v9' })) })
    await expect(executeReconcile(options)).rejects.toMatchObject({ code: 'reconcile_previous_required' })
    expect(options.validateVersion).not.toHaveBeenCalled()
  })

  it('is idempotent and skips an identical state write', async () => {
    const options = reconcileHarness()
    options.readState = vi.fn(async () => ({
      schemaVersion: 2, version: 'v2', previousVersion: 'v1', contentHash: 'hash-v1',
      manifestKey: 'snapshots/v2/cities/Taipei/manifest.json', counts: manifest.counts, quality: {},
      generatedAt: manifest.generatedAt, publishedAt: '2026-07-21T00:00:00.000Z', source: 'TDX', workflowRun: null,
    }))
    const outcome = await executeReconcile(options)
    expect(outcome.outcome).toBe('already_reconciled')
    expect(options.writeState).not.toHaveBeenCalled()
  })

  it('classifies a reconcile state write failure without raw details', async () => {
    const options = reconcileHarness({ explicitPrevious: 'v1', writeState: vi.fn(async () => { throw new Error('token=secret') }) })
    await expect(executeReconcile(options)).rejects.toMatchObject({ code: 'reconcile_failed' })
  })
})

describe('safeOperationDiagnostic', () => {
  it('emits only bounded allowlisted fields', () => {
    const raw = Object.assign(new Error('https://secret.example/?token=abc'), {
      stack: 'token=abc',
      code: 'restore_failed',
      activeVersion: 'v2',
      previousVersion: 'v1',
    })
    const diagnostic = safeOperationDiagnostic(raw, 'rollback', 'Taipei')
    expect(diagnostic).toEqual({
      event: 'snapshot_authority_operation',
      operation: 'rollback',
      city: 'Taipei',
      outcome: 'restore_failed',
      activeVersion: 'v2',
      previousVersion: 'v1',
      targetVersion: null,
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|token|https|stack/)
    expect(safeOperationDiagnostic(new Error('raw secret'), 'rollback', 'Taipei').outcome).toBe('unknown')
  })
})
