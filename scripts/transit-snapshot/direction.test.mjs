import { describe, expect, it } from 'vitest'
import { isSupportedBusDirection } from './direction.mjs'

describe('snapshot bus direction', () => {
  it('accepts outbound, inbound, and circular TDX directions', () => {
    expect([0, 1, 2].every(isSupportedBusDirection)).toBe(true)
  })

  it('rejects missing and unknown direction values', () => {
    expect([-1, 3, undefined, null].some(isSupportedBusDirection)).toBe(false)
  })
})
