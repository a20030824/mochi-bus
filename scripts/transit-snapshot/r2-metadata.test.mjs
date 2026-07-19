import { describe, expect, it } from 'vitest'
import { parseContentLength } from './r2-metadata.mjs'

describe('R2 HEAD metadata', () => {
  it.each([
    [null, null],
    ['123', 123],
    ['invalid', null],
    ['0', 0],
  ])('parses Content-Length %j as %j', (value, expected) => {
    expect(parseContentLength(value)).toBe(expected)
  })
})
