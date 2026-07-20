import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeBoardId,
  isHomeDirection,
  persistHomeBoard,
  readBoards,
  readHomeBoard,
  resetTdxAuthMemoryForTests,
  resolveHomeBoard,
  saveHomeBoardToFavorites,
  setActiveBoard,
  toggleHomeDirection,
  writeBoards,
  writeHomeBoard,
  type FavoriteBoard,
  type FavoriteBus,
} from './store'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

const now = '2026-07-20T00:00:00.000Z'
const bus = (routeName: string, routeUid: string, stopUid: string, direction: 0 | 1 = 0): FavoriteBus => ({
  city: 'Taipei',
  routeName,
  routeUid,
  patternId: `${routeUid}-pattern`,
  stopName: '公館',
  stopUid,
  direction,
})
const board = (id: string, placeId: string, buses: FavoriteBus[]): FavoriteBoard => ({
  version: 2,
  id,
  title: placeId === 'P1' ? '公館' : '西門站',
  city: 'Taipei',
  placeId,
  latitude: 25,
  longitude: 121,
  buses,
  createdAt: now,
  updatedAt: now,
})

const place = (placeId: string) => ({
  placeId,
  name: placeId === 'P1' ? '公館' : '西門站',
  latitude: 25,
  longitude: 121,
})

describe('home board reverse transitions', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', new MemoryStorage())
    vi.stubGlobal('sessionStorage', new MemoryStorage())
    resetTdxAuthMemoryForTests()
  })

  afterEach(() => {
    resetTdxAuthMemoryForTests()
    vi.unstubAllGlobals()
  })

  it('keeps the only saved direction selected instead of producing an empty cover', () => {
    const onlyBus = bus('307', 'R1', 'S1')
    const saved = board('saved', 'P1', [onlyBus])
    writeBoards([saved])
    setActiveBoard(saved.id)

    const selected = toggleHomeDirection('Taipei', place('P1'), onlyBus)

    expect(selected).toBe(true)
    expect(readHomeBoard()).toBeNull()
    expect(readBoards()).toEqual([saved])
    expect(activeBoardId()).toBe(saved.id)
    expect(isHomeDirection('Taipei', 'P1', onlyBus)).toBe(true)
  })

  it('falls back to another saved favorite after removing the last direction', () => {
    const firstBus = bus('307', 'R1', 'S1')
    const secondBus = { ...bus('藍1', 'R2', 'S2'), stopName: '西門站' }
    const first = board('first', 'P1', [firstBus])
    const second = board('second', 'P2', [secondBus])
    writeBoards([first, second])
    setActiveBoard(first.id)

    const selected = toggleHomeDirection('Taipei', place('P1'), firstBus)

    expect(selected).toBe(false)
    expect(readHomeBoard()).toBeNull()
    expect(activeBoardId()).toBe(second.id)
    expect(resolveHomeBoard(readBoards())?.id).toBe(second.id)
    expect(readBoards()).toEqual([first, second])
  })

  it('creates a subset cover without mutating the saved favorite', () => {
    const firstBus = bus('307', 'R1', 'S1')
    const secondBus = bus('672', 'R2', 'S2', 1)
    const saved = board('saved', 'P1', [firstBus, secondBus])
    writeBoards([saved])
    setActiveBoard(saved.id)

    const selected = toggleHomeDirection('Taipei', place('P1'), secondBus)

    expect(selected).toBe(false)
    expect(readBoards()[0].buses).toHaveLength(2)
    expect(readHomeBoard()?.buses).toEqual([firstBus])
    expect(resolveHomeBoard(readBoards())?.buses).toEqual([firstBus])
  })

  it('collapses a subset cover after its removed direction is toggled back', () => {
    const firstBus = bus('307', 'R1', 'S1')
    const secondBus = bus('672', 'R2', 'S2', 1)
    const saved = board('saved', 'P1', [firstBus, secondBus])
    writeBoards([saved])
    setActiveBoard(saved.id)

    toggleHomeDirection('Taipei', place('P1'), secondBus)
    const selected = toggleHomeDirection('Taipei', place('P1'), secondBus)

    expect(selected).toBe(true)
    expect(readHomeBoard()).toBeNull()
    expect(activeBoardId()).toBe(saved.id)
    expect(resolveHomeBoard(readBoards())?.id).toBe(saved.id)
  })

  it('merges a subset draft without deleting directions already saved at that place', () => {
    const firstBus = bus('307', 'R1', 'S1')
    const secondBus = bus('672', 'R2', 'S2', 1)
    const saved = board('saved', 'P1', [firstBus, secondBus])
    writeBoards([saved])
    writeHomeBoard(board('draft', 'P1', [firstBus]))

    const result = saveHomeBoardToFavorites()

    expect(result?.id).toBe(saved.id)
    expect(readBoards()).toHaveLength(1)
    expect(readBoards()[0].buses).toEqual([firstBus, secondBus])
    expect(readHomeBoard()).toBeNull()
  })

  it('writes ETA identity repairs back to a draft without touching saved favorites', () => {
    const savedBus = bus('307', 'R1', 'S1')
    const draftBus = { ...bus('藍1', 'R2', 'S2'), stopName: '西門站' }
    const saved = board('saved', 'P1', [savedBus])
    const draft = board('draft', 'P2', [draftBus])
    writeBoards([saved])
    writeHomeBoard(draft)

    const repaired = {
      ...draft,
      buses: [{ ...draftBus, directionLabel: '西門站 → 內湖' }],
    }
    persistHomeBoard(repaired)

    expect(readBoards()).toEqual([saved])
    expect(readHomeBoard()?.buses[0].directionLabel).toBe('西門站 → 內湖')
  })
})
