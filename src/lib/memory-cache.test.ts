import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryCacheGet, memoryCacheSet, resetMemoryCacheForTests } from './memory-cache'

describe('memory cache', () => {
  beforeEach(() => {
    vi.useRealTimers()
    resetMemoryCacheForTests()
  })

  afterEach(() => vi.useRealTimers())

  it('expires entries by TTL', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-10T00:00:00Z'))
    memoryCacheSet('short', 'value', 1)

    expect(memoryCacheGet('short')).toBe('value')
    vi.advanceTimersByTime(1000)
    expect(memoryCacheGet('short')).toBeUndefined()
  })

  it('uses a 500-entry hard cap with LRU eviction', () => {
    for (let index = 0; index < 500; index += 1) {
      memoryCacheSet(`entry-${index}`, index, 60)
    }

    // entry-0 變成最近使用；下一筆應淘汰 entry-1。
    expect(memoryCacheGet('entry-0')).toBe(0)
    memoryCacheSet('entry-500', 500, 60)

    expect(memoryCacheGet('entry-0')).toBe(0)
    expect(memoryCacheGet('entry-1')).toBeUndefined()
    expect(memoryCacheGet('entry-500')).toBe(500)
  })
})
