import { describe, expect, it } from 'vitest'
import { matchStopsToShape } from './shape-matcher'

describe('matchStopsToShape', () => {
  it('uses stop order to disambiguate repeated points on a loop', () => {
    const shape: Array<[number, number]> = [[0, 0], [1, 0], [2, 0], [1, 0], [0, 0]]
    const matches = matchStopsToShape([
      { sequence: 1, coordinates: [0, 0] },
      { sequence: 2, coordinates: [1, 0] },
      { sequence: 3, coordinates: [2, 0] },
      { sequence: 4, coordinates: [1, 0] },
      { sequence: 5, coordinates: [0, 0] },
    ], shape)

    expect([...matches.values()]).toEqual([0, 1, 2, 3, 4])
  })

  it('supports a shape encoded in reverse direction', () => {
    const matches = matchStopsToShape([
      { sequence: 1, coordinates: [0, 0] },
      { sequence: 2, coordinates: [1, 0] },
      { sequence: 3, coordinates: [2, 0] },
    ], [[2, 0], [1, 0], [0, 0]])

    expect([...matches.values()]).toEqual([2, 1, 0])
  })
})
