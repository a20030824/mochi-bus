import { describe, expect, it } from 'vitest'
import { hasScrollableContentBelow } from './scroll-fade'

describe('hasScrollableContentBelow', () => {
  it('stays off when all content fits', () => {
    expect(hasScrollableContentBelow(300, 0, 300)).toBe(false)
  })

  it('turns on while content remains below the viewport', () => {
    expect(hasScrollableContentBelow(500, 80, 300)).toBe(true)
  })

  it('stays off at the bottom and within the rounding tolerance', () => {
    expect(hasScrollableContentBelow(500, 200, 300)).toBe(false)
    expect(hasScrollableContentBelow(500, 196, 300)).toBe(false)
  })
})
