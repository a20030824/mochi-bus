import { describe, expect, it } from 'vitest'
import { busKey, migrateLegacyPresets, normalizeFavoriteBoards, pruneOtherMapBoards, sameFavoriteDirection, type FavoriteBoard, type FavoriteBus } from './favorite-board'

const now = '2026-07-04T00:00:00.000Z'

describe('migrateLegacyPresets', () => {
  it('converts v1 presets into single-bus boards', () => {
    const boards = migrateLegacyPresets([{
      id: 'p1',
      city: 'Taipei',
      routeName: '307',
      routeUid: 'TPE19108',
      stopName: '捷運西門站',
      stopUid: 'TPE213044',
      direction: 1,
      createdAt: '2025-01-01T00:00:00.000Z',
    }], now)

    expect(boards).toEqual([{
      version: 2,
      id: 'p1',
      title: '捷運西門站',
      buses: [{
        city: 'Taipei',
        routeName: '307',
        routeUid: 'TPE19108',
        identityStatus: undefined,
        stopName: '捷運西門站',
        stopUid: 'TPE213044',
        direction: 1,
      }],
      createdAt: '2025-01-01T00:00:00.000Z',
      updatedAt: now,
    }])
  })

  it('drops entries without stopUid or routeName and tolerates junk', () => {
    const boards = migrateLegacyPresets([
      null,
      {},
      { routeName: '307' },
      { stopUid: 'TPE1' },
      { routeName: '307', stopUid: 'TPE1' },
    ], now)
    expect(boards).toHaveLength(1)
    expect(boards[0].buses[0].stopUid).toBe('TPE1')
  })

  it('falls back to label then generic title, and coerces direction', () => {
    const boards = migrateLegacyPresets([
      { routeName: '307', stopUid: 'TPE1', label: '上班' },
      { routeName: '307', stopUid: 'TPE2', direction: 7 },
    ], now)
    expect(boards[0].title).toBe('上班')
    expect(boards[1].title).toBe('常用站牌')
    expect(boards[1].buses[0].direction).toBe(0)
  })

  it('returns empty for non-array input', () => {
    expect(migrateLegacyPresets(undefined, now)).toEqual([])
    expect(migrateLegacyPresets('junk', now)).toEqual([])
  })
})

describe('sameFavoriteDirection', () => {
  const base: FavoriteBus = {
    routeName: '307',
    routeUid: 'TPE19108',
    stopUid: 'TPE213044',
    direction: 0,
    directionLabel: 'A → B',
  }

  it('matches on route pattern identity and stopUid', () => {
    expect(sameFavoriteDirection(base, { ...base })).toBe(true)
    expect(sameFavoriteDirection(base, { ...base, direction: 1 })).toBe(false)
    expect(sameFavoriteDirection(base, { ...base, stopUid: 'TPE9' })).toBe(false)
    expect(sameFavoriteDirection(base, { ...base, subRouteUid: 'OTHER' })).toBe(true)
    expect(sameFavoriteDirection(
      { ...base, subRouteUid: 'SUB-1' },
      { ...base, subRouteUid: 'SUB-2' },
    )).toBe(false)
  })

  it('treats missing labels as equal to empty', () => {
    expect(sameFavoriteDirection(
      { ...base, directionLabel: undefined },
      { ...base, directionLabel: '' },
    )).toBe(true)
  })
})

describe('pruneOtherMapBoards', () => {
  const board = (id: string, extra: Partial<FavoriteBoard> = {}): FavoriteBoard => ({
    version: 2, id, title: id, buses: [], createdAt: now, updatedAt: now, ...extra,
  })

  it('keeps setup boards and the current place, drops other map boards', () => {
    const boards = [
      board('setup'),
      board('same-place', { city: 'Chiayi', placeId: 'P1' }),
      board('other-place', { city: 'Chiayi', placeId: 'P2' }),
      board('other-city', { city: 'Taipei', placeId: 'P1' }),
    ]
    expect(pruneOtherMapBoards(boards, 'Chiayi', 'P1').map((item) => item.id))
      .toEqual(['setup', 'same-place'])
  })
})

describe('busKey', () => {
  it('includes route, subroute, pattern, direction and stop identity', () => {
    const base = { routeUid: 'TPE1', routeName: '307', stopUid: 'S1', direction: 0 as const }
    expect(busKey(base)).not.toBe(busKey({ ...base, subRouteUid: 'SUB-1' }))
    expect(busKey({ ...base, subRouteUid: 'SUB-1' })).not.toBe(busKey({ ...base, subRouteUid: 'SUB-2' }))
    expect(busKey({ ...base, patternId: 'P1' })).not.toBe(busKey({ ...base, patternId: 'P2' }))
  })

  it('falls back to routeName for legacy records without RouteUID', () => {
    expect(busKey({ routeName: '307', stopUid: 'S1', direction: 1 })).toContain('name:307')
  })
})

describe('normalizeFavoriteBoards', () => {
  it('marks only records without RouteUID as legacy ambiguous', () => {
    const boards = normalizeFavoriteBoards([{
      version: 2,
      id: 'b1',
      title: '常用站牌',
      buses: [
        { routeName: '203', stopUid: 'S1', direction: 0 },
        { routeName: '203', routeUid: 'R1', stopUid: 'S1', direction: 0 },
      ],
      createdAt: now,
      updatedAt: now,
    }])

    expect(boards[0].buses[0].identityStatus).toBe('legacy-ambiguous')
    expect(boards[0].buses[1].identityStatus).toBeUndefined()
  })

  it('marks old map favorites without a pattern identity for repair', () => {
    const boards = normalizeFavoriteBoards([{
      version: 2,
      id: 'map-1',
      title: '捷運站',
      placeId: 'place-1',
      buses: [
        { routeName: '203', routeUid: 'R1', stopUid: 'S1', direction: 0 },
        { routeName: '203', routeUid: 'R1', patternId: 'P1', stopUid: 'S1', direction: 0 },
      ],
      createdAt: now,
      updatedAt: now,
    }])

    expect(boards[0].buses[0].identityStatus).toBe('legacy-ambiguous')
    expect(boards[0].buses[1].identityStatus).toBeUndefined()
  })
})
