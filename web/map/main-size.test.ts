/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import mainSource from './main.ts?raw'

const MAP_MAIN_LINE_LIMIT = 2732

describe('map main architecture boundary', () => {
  it('does not grow without extracting another responsibility', () => {
    const lineCount = mainSource.split(/\r?\n/).length
    expect(lineCount).toBeLessThanOrEqual(MAP_MAIN_LINE_LIMIT)
  })
})
