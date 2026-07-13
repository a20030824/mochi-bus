import { describe, expect, it } from 'vitest'
import { getJourneySegmentCoordinates } from './journey-segment'

const shape: Array<[number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0],
]

describe('getJourneySegmentCoordinates', () => {
  it('returns only the forward travelled portion of a longer shape', () => {
    const segment = getJourneySegmentCoordinates(shape, [
      { sequence: 1, coordinates: [0, 0] },
      { sequence: 2, coordinates: [2, 0] },
      { sequence: 3, coordinates: [4, 0] },
      { sequence: 4, coordinates: [5, 0] },
    ], 2, 3)

    expect(segment).toEqual([[2, 0], [3, 0], [4, 0]])
    expect(segment).not.toContainEqual([0, 0])
    expect(segment).not.toContainEqual([5, 0])
  })

  it('handles board and alight indexes in reverse order', () => {
    const segment = getJourneySegmentCoordinates(shape, [
      { sequence: 1, coordinates: [0, 0] },
      { sequence: 2, coordinates: [2, 0] },
      { sequence: 3, coordinates: [4, 0] },
      { sequence: 4, coordinates: [5, 0] },
    ], 3, 2)

    expect(segment).toEqual([[2, 0], [3, 0], [4, 0]])
  })

  it('matches stops that are near, but not exactly on, shape coordinates', () => {
    const segment = getJourneySegmentCoordinates(shape, [
      { sequence: 1, coordinates: [0.1, 0.02] },
      { sequence: 2, coordinates: [2.1, -0.02] },
      { sequence: 3, coordinates: [4.1, 0.02] },
    ], 2, 3)

    expect(segment).toEqual([[2, 0], [3, 0], [4, 0]])
  })

  it('returns null when either selected stop is missing', () => {
    const stops = [{ sequence: 1, coordinates: [0, 0] as [number, number] }]
    expect(getJourneySegmentCoordinates(shape, stops, 1, 2)).toBeNull()
    expect(getJourneySegmentCoordinates(shape, stops, 0, 1)).toBeNull()
  })

  it('returns null when a segment would contain fewer than two coordinates', () => {
    const stops = [
      { sequence: 1, coordinates: [2, 0] as [number, number] },
      { sequence: 2, coordinates: [2, 0] as [number, number] },
    ]
    expect(getJourneySegmentCoordinates(shape, stops, 1, 2)).toBeNull()
  })

  it('does not mutate the input shape', () => {
    const original = shape.map((point) => [...point] as [number, number])
    const segment = getJourneySegmentCoordinates(shape, [
      { sequence: 1, coordinates: [1, 0] },
      { sequence: 2, coordinates: [3, 0] },
    ], 1, 2)

    expect(shape).toEqual(original)
    segment![0][0] = 99
    expect(shape).toEqual(original)
  })
})
