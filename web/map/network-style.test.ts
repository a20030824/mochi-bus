import { describe, expect, it } from 'vitest'
import { networkStopRadius } from './network-style'

describe('city network marker sizing', () => {
  it('keeps the three established zoom tiers', () => {
    expect(networkStopRadius(11.75)).toBe(1.4)
    expect(networkStopRadius(12)).toBe(2.5)
    expect(networkStopRadius(15)).toBe(4)
  })
})
