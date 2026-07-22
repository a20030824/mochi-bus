import { describe, expect, it } from 'vitest'
import { parseJsonLines, toJsonLines, validateDistributionTree } from './report-schema.mjs'
import { distribution, omitNondeterministic, percentile, stableStringify } from './util.mjs'

describe('measurement report schema utilities', () => {
  it('uses a fixed nearest-rank percentile algorithm', () => {
    const values = [9, 1, 5, 3]
    expect(percentile(values, 0)).toBe(1)
    expect(percentile(values, 0.5)).toBe(3)
    expect(percentile(values, 0.75)).toBe(5)
    expect(percentile(values, 0.99)).toBe(9)
  })

  it('returns null percentiles for a zero-count dataset', () => {
    expect(distribution([])).toEqual({ count: 0, min: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null })
  })

  it('enforces percentile ordering', () => {
    expect(() => validateDistributionTree({ broken: { count: 2, min: 1, median: 3, p75: 2, p90: 3, p95: 3, p99: 3, max: 3 } })).toThrow()
  })

  it('writes exactly one JSON record per line in stable order', () => {
    const records = [{ z: 1, a: 2 }, { b: 3 }]
    const source = toJsonLines(records)
    expect(source.split('\n').filter(Boolean)).toHaveLength(2)
    expect(parseJsonLines(source)).toEqual([{ a: 2, z: 1 }, { b: 3 }])
  })

  it('excludes timing and memory fields from deterministic content', () => {
    const first = omitNondeterministic({ id: 'x', pairTimeMs: 1, rssBytes: 10 })
    const second = omitNondeterministic({ id: 'x', pairTimeMs: 9, rssBytes: 99 })
    expect(stableStringify(first)).toBe(stableStringify(second))
  })
})
