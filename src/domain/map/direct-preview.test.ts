import { describe, expect, it } from 'vitest'
import { selectDirectPreviewEntries } from './direct-preview'

const routes = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }))
const indexes = <T>(entries: Array<{ route: T; index: number }>) => entries.map((entry) => entry.index)

describe('selectDirectPreviewEntries', () => {
  it('returns all routes when fewer than the limit exist', () => {
    const result = selectDirectPreviewEntries(routes(3), 0)
    expect(indexes(result)).toEqual([0, 1, 2])
  })

  it('returns all routes when exactly the limit exist', () => {
    const result = selectDirectPreviewEntries(routes(8), 7)
    expect(indexes(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps the original first eight when the selection is already visible', () => {
    const result = selectDirectPreviewEntries(routes(10), 2)
    expect(indexes(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('replaces the eighth preview slot with a selected route outside the first eight', () => {
    const result = selectDirectPreviewEntries(routes(10), 8)
    expect(indexes(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 8])
    expect(new Set(indexes(result)).size).toBe(result.length)
  })

  it('includes a selected route at the end of a longer list', () => {
    const result = selectDirectPreviewEntries(routes(12), 11)
    expect(indexes(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 11])
  })

  it('normalizes a negative selected index safely', () => {
    const result = selectDirectPreviewEntries(routes(3), -4)
    expect(indexes(result)).toEqual([0, 1, 2])
  })

  it('normalizes an oversized selected index to the last route', () => {
    const result = selectDirectPreviewEntries(routes(10), 99)
    expect(indexes(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 9])
  })

  it('supports a limit of one by returning only the selected route', () => {
    const result = selectDirectPreviewEntries(routes(4), 2, 1)
    expect(indexes(result)).toEqual([2])
  })

  it('returns an empty set for an empty route list', () => {
    expect(selectDirectPreviewEntries([], 0)).toEqual([])
  })

  it('does not modify the original routes array', () => {
    const input = routes(10)
    const original = [...input]
    selectDirectPreviewEntries(input, 9)
    expect(input).toEqual(original)
  })
})
