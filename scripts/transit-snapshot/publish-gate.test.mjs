import { describe, expect, it, vi } from 'vitest'
import { publishWithRollback } from './publish-gate.mjs'

function operations(overrides = {}) {
  const calls = []
  const operation = (name) => vi.fn(async () => { calls.push(name) })
  return {
    calls,
    options: {
      targetVersion: 'v2', previousVersion: 'v1',
      stage: operation('stage'), validate: operation('validate'), activate: operation('activate'),
      smoke: operation('smoke'), rollback: operation('rollback'), cleanup: operation('cleanup'),
      ...overrides,
    },
  }
}

describe('publishWithRollback', () => {
  it('activates only after staging and remote validation', async () => {
    const { calls, options } = operations()
    await publishWithRollback(options)
    expect(calls).toEqual(['stage', 'validate', 'activate', 'smoke', 'cleanup'])
  })

  it('never activates when validation fails', async () => {
    const validate = vi.fn(async () => { throw new Error('invalid') })
    const { options } = operations({ validate })
    await expect(publishWithRollback(options)).rejects.toThrow('invalid')
    expect(options.activate).not.toHaveBeenCalled()
    expect(options.cleanup).not.toHaveBeenCalled()
  })

  it('restores the previous pointer and preserves artifacts when smoke fails', async () => {
    const smoke = vi.fn(async () => { throw new Error('smoke failed') })
    const { calls, options } = operations({ smoke })
    await expect(publishWithRollback(options)).rejects.toThrow('smoke failed')
    expect(options.rollback).toHaveBeenCalledWith('v1')
    expect(options.cleanup).not.toHaveBeenCalled()
    expect(calls).toEqual(['stage', 'validate', 'activate', 'rollback'])
  })
})
