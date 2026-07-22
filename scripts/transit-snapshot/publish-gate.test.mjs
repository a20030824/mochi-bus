import { describe, expect, it, vi } from 'vitest'
import { publishWithRollback } from './publish-gate.mjs'

function operations(overrides = {}) {
  const calls = []
  const operation = (name, result = undefined) => vi.fn(async () => { calls.push(name); return result })
  return {
    calls,
    options: {
      targetVersion: 'v2', previousVersion: 'v1',
      stage: operation('stage'), validate: operation('validate'), activate: operation('activate', true),
      smoke: operation('smoke'), rollback: operation('rollback', true), finalize: operation('finalize'),
      cleanup: operation('cleanup'),
      ...overrides,
    },
  }
}

describe('publishWithRollback', () => {
  it('activates only after staging and remote validation', async () => {
    const { calls, options } = operations()
    await publishWithRollback(options)
    expect(calls).toEqual(['stage', 'validate', 'activate', 'smoke', 'finalize', 'cleanup'])
  })

  it('never activates when validation fails', async () => {
    const validate = vi.fn(async () => { throw new Error('invalid') })
    const { options } = operations({ validate })
    await expect(publishWithRollback(options)).rejects.toThrow('invalid')
    expect(options.activate).not.toHaveBeenCalled()
  })

  it('fails on a guarded activation conflict before smoke', async () => {
    const { options } = operations({ activate: vi.fn(async () => false) })
    await expect(publishWithRollback(options)).rejects.toMatchObject({ code: 'activation_conflict' })
    expect(options.smoke).not.toHaveBeenCalled()
  })

  it('restores the previous pointer and preserves artifacts when smoke fails', async () => {
    const smoke = vi.fn(async () => { throw new Error('smoke failed') })
    const { calls, options } = operations({ smoke })
    await expect(publishWithRollback(options)).rejects.toMatchObject({ code: 'smoke_failed_restored' })
    expect(options.rollback).toHaveBeenCalledWith('v1', 'v2')
    expect(options.cleanup).not.toHaveBeenCalled()
    expect(calls).toEqual(['stage', 'validate', 'activate', 'rollback'])
  })

  it('raises a high-severity restore failure when rollback conflicts or throws', async () => {
    const smoke = vi.fn(async () => { throw new Error('smoke failed') })
    const { options } = operations({ smoke, rollback: vi.fn(async () => false) })
    await expect(publishWithRollback(options)).rejects.toMatchObject({ code: 'restore_failed' })
  })

  it('keeps healthy D1 authority and requires reconcile when state finalization fails', async () => {
    const { options } = operations({ finalize: vi.fn(async () => { throw new Error('R2 state failed') }) })
    await expect(publishWithRollback(options)).rejects.toMatchObject({ code: 'state_write_failed_reconcile_required' })
    expect(options.rollback).not.toHaveBeenCalled()
    expect(options.cleanup).not.toHaveBeenCalled()
  })

  it('never rolls back a healthy active version for cleanup failure', async () => {
    const { options } = operations({ cleanup: vi.fn(async () => { throw new Error('cleanup failed') }) })
    await expect(publishWithRollback(options)).rejects.toMatchObject({ code: 'cleanup_failed' })
    expect(options.rollback).not.toHaveBeenCalled()
  })
})
