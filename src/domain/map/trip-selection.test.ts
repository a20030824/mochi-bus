import { describe, expect, it } from 'vitest'
import { getTripSelectionConflict } from './trip-selection'

const from = { placeId: 'from' }
const to = { placeId: 'to' }
const conflictMessage = '出發位置和目的地是同一站，請選另一個站牌'

describe('getTripSelectionConflict', () => {
  it('detects a destination candidate that matches the selected origin', () => {
    expect(getTripSelectionConflict('to', from, from, undefined)).toBe(conflictMessage)
  })

  it('detects an origin candidate that matches the selected destination', () => {
    expect(getTripSelectionConflict('from', to, undefined, to)).toBe(conflictMessage)
  })

  it('allows a different candidate and does not inspect the opposite endpoint when absent', () => {
    expect(getTripSelectionConflict('from', from, undefined, undefined)).toBeUndefined()
    expect(getTripSelectionConflict('to', to, from, undefined)).toBeUndefined()
  })

  it('returns no conflict for an undefined candidate', () => {
    expect(getTripSelectionConflict('from', undefined, undefined, to)).toBeUndefined()
  })
})
