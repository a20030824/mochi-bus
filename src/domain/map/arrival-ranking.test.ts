import { describe, expect, it } from 'vitest'
import { includeFocusedCandidate, selectRealtimeCandidates } from './arrival-ranking'

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

  it('fills leftover slots with unknown-schedule routes (Taipei gaps: no schedule ≠ not running)', () => {
    const selected = selectRealtimeCandidates([
      { id: 'unknown-a', scheduleMinutes: null },
      { id: 'scheduled', scheduleMinutes: 5 },
      { id: 'unknown-b', scheduleMinutes: null },
      { id: 'unknown-c', scheduleMinutes: null },
    ])
    expect(selected.map((item) => item.id)).toEqual(['scheduled', 'unknown-a', 'unknown-b'])
  })

  it('keeps the homepage direction in the realtime budget', () => {
    const focused = { id: 'home' }
    expect(includeFocusedCandidate([{ id: 'a' }, { id: 'b' }, { id: 'c' }], focused).map((item) => item.id))
      .toEqual(['home', 'a', 'b'])
  })
})
