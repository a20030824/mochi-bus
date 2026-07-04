import { describe, expect, it } from 'vitest'
import { busKey, migrateLegacyPresets, pruneOtherMapBoards, sameFavoriteDirection, type FavoriteBoard, type FavoriteBus } from './favorite-board'

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

  it('matches on routeUid, stopUid, direction and label', () => {
    expect(sameFavoriteDirection(base, { ...base })).toBe(true)
    expect(sameFavoriteDirection(base, { ...base, direction: 1 })).toBe(false)
    expect(sameFavoriteDirection(base, { ...base, stopUid: 'TPE9' })).toBe(false)
    expect(sameFavoriteDirection(base, { ...base, directionLabel: 'B → A' })).toBe(false)
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
  it('prefers routeUid and falls back to routeName', () => {
    expect(busKey({ routeUid: 'TPE1', routeName: '307', stopUid: 'S1', direction: 0 })).toBe('TPE1:S1:0')
    expect(busKey({ routeName: '307', stopUid: 'S1', direction: 1 })).toBe('307:S1:1')
  })
})
