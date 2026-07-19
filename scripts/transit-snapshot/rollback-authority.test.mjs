import { describe, expect, it } from 'vitest'
import { resolveRollbackAuthority } from './rollback-authority.mjs'

describe('snapshot rollback authority', () => {
  it('uses the D1 active pointer when R2 state agrees', () => {
    expect(resolveRollbackAuthority({
      city: 'Taipei',
      state: { version: '20260719T192700000Z' },
      d1ActiveVersion: '20260719T192700000Z',
    })).toBe('20260719T192700000Z')
  })

  it('fails closed when the D1 active pointer is missing or malformed', () => {
    expect(() => resolveRollbackAuthority({
      city: 'Taipei', state: { version: 'v1' }, d1ActiveVersion: null,
    })).toThrow('D1 has no valid active snapshot')
    expect(() => resolveRollbackAuthority({
      city: 'Taipei', state: { version: 'v1' }, d1ActiveVersion: 'not safe/value',
    })).toThrow('D1 has no valid active snapshot')
  })

  it('fails closed when R2 state disagrees with D1', () => {
    expect(() => resolveRollbackAuthority({
      city: 'Taipei', state: { version: 'v0' }, d1ActiveVersion: 'v1',
    })).toThrow('Rollback authority mismatch')
  })
})
