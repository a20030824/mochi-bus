import { describe, expect, it } from 'vitest'
import { selectRealtimeCandidates } from './arrival-ranking'

describe('selectRealtimeCandidates', () => {
  it('keeps only the first three scheduled arrivals within thirty minutes', () => {
    const selected = selectRealtimeCandidates([
      { id: 'late', scheduleMinutes: 31 },
      { id: 'third', scheduleMinutes: 20 },
      { id: 'first', scheduleMinutes: 3 },
      { id: 'none', scheduleMinutes: null },
      { id: 'fourth', scheduleMinutes: 25 },
      { id: 'second', scheduleMinutes: 12 },
    ])
    expect(selected.map((item) => item.id)).toEqual(['first', 'second', 'third'])
  })
})
