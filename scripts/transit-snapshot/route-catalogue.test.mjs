import { describe, expect, it } from 'vitest'
import { retainRoutesWithPatterns } from './route-catalogue.mjs'

describe('retainRoutesWithPatterns', () => {
  it('removes catalogue routes and schedules that have no generated pattern', () => {
    const routes = new Map([
      ['R1', { uid: 'R1' }],
      ['R2', { uid: 'R2' }],
      ['R3', { uid: 'R3' }],
    ])
    const schedules = new Map([
      ['R1', [{ Direction: 0 }]],
      ['R2', [{ Direction: 1 }]],
      ['R3', []],
    ])

    const removed = retainRoutesWithPatterns({
      routes,
      schedules,
      patterns: [
        { id: 'P1', routeUid: 'R1' },
        { id: 'P2', routeUid: 'R2' },
      ],
    })

    expect(removed).toEqual(['R3'])
    expect([...routes.keys()]).toEqual(['R1', 'R2'])
    expect([...schedules.keys()]).toEqual(['R1', 'R2'])
  })

  it('keeps every route when all routes have at least one pattern', () => {
    const routes = new Map([['R1', { uid: 'R1' }]])
    const schedules = new Map([['R1', []]])

    expect(retainRoutesWithPatterns({
      routes,
      schedules,
      patterns: [{ id: 'P1', routeUid: 'R1' }],
    })).toEqual([])
    expect(routes.has('R1')).toBe(true)
    expect(schedules.has('R1')).toBe(true)
  })
})
