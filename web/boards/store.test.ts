import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APPEARANCE_STORAGE_KEY,
  LEGACY_APPEARANCE_STORAGE_KEYS,
} from '../../src/domain/appearance'
import {
  activeBoardId,
  clearHomeBoard,
  clearLocalData,
  clearTdxAuth,
  consumeTdxAuthMigrationNotice,
  getTdxAuthState,
  isHomeDirection,
  migrateBoards,
  readBoards,
  readHomeBoard,
  resetTdxAuthMemoryForTests,
  resolveHomeBoard,
  saveHomeBoardToFavorites,
  setActiveBoard,
  setTdxAuth,
  toggleHomeDirection,
  writeBoards,
  writeHomeBoard,
  type FavoriteBoard,
  type FavoriteBus,
  type TdxAuth,
} from './store'

const LEGACY_KEY = 'mochi.bus.tdxAuth.v1'
const SESSION_KEY = 'mochi.bus.tdxAuth.session.v2'
const DEVICE_KEY = 'mochi.bus.tdxAuth.device.v2'
const HOME_KEY = 'mochi.bus.homeBoard.v1'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, String(value)) }
}

class DeniedStorage extends MemoryStorage {
  override getItem(): string | null { throw new DOMException('denied', 'SecurityError') }
  override removeItem(): void { throw new DOMException('denied', 'SecurityError') }
  override setItem(): void { throw new DOMException('denied', 'SecurityError') }
}

class RemoveDeniedStorage extends MemoryStorage {
  override removeItem(): void { throw new DOMException('denied', 'SecurityError') }
}

const now = '2026-07-20T00:00:00.000Z'
const bus = (routeName: string, routeUid: string, direction: 0 | 1 = 0): FavoriteBus => ({
  city: 'Taipei',
  routeName,
  routeUid,
  patternId: `${routeUid}-pattern`,
  stopName: '公館',
  stopUid: `${routeUid}-stop`,
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

describe('home board lifecycle', () => {
  let local: MemoryStorage
  let session: MemoryStorage

  beforeEach(() => {
    local = new MemoryStorage()
    session = new MemoryStorage()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    resetTdxAuthMemoryForTests()
  })

  afterEach(() => {
    resetTdxAuthMemoryForTests()
    vi.unstubAllGlobals()
  })

  it('changes the cover without deleting saved favorites', () => {
    const saved = board('saved', 'P1', [bus('307', 'R1')])
    writeBoards([saved])
    setActiveBoard(saved.id)

    const selected = toggleHomeDirection('Taipei', {
      placeId: 'P2', name: '西門站', latitude: 25.04, longitude: 121.51,
    }, { ...bus('藍1', 'R2'), stopName: '西門站' })

    expect(selected).toBe(true)
    expect(readBoards()).toEqual([saved])
    expect(readHomeBoard()?.placeId).toBe('P2')
    expect(resolveHomeBoard(readBoards())?.title).toBe('西門站')
    expect(isHomeDirection('Taipei', 'P2', { ...bus('藍1', 'R2'), stopName: '西門站' })).toBe(true)
  })

  it('collapses an exact temporary cover into the matching saved board', () => {
    const saved = board('saved', 'P1', [bus('307', 'R1')])
    writeBoards([saved])
    writeHomeBoard({ ...saved, id: 'draft', updatedAt: '2026-07-20T01:00:00.000Z' })

    expect(migrateBoards()).toEqual([saved])
    expect(readHomeBoard()).toBeNull()
    expect(activeBoardId()).toBe(saved.id)
  })

  it('merges a temporary cover into an existing place when added to favorites', () => {
    const first = bus('307', 'R1')
    const second = bus('藍1', 'R2', 1)
    const saved = board('saved', 'P1', [first])
    writeBoards([saved])
    writeHomeBoard(board('draft', 'P1', [first, second]))

    const result = saveHomeBoardToFavorites()

    expect(result?.id).toBe(saved.id)
    expect(readBoards()).toHaveLength(1)
    expect(readBoards()[0].buses).toHaveLength(2)
    expect(readHomeBoard()).toBeNull()
    expect(activeBoardId()).toBe(saved.id)
  })

  it('selecting a saved board clears the temporary cover', () => {
    const saved = board('saved', 'P1', [bus('307', 'R1')])
    writeBoards([saved])
    writeHomeBoard(board('draft', 'P2', [bus('藍1', 'R2')]))

    setActiveBoard(saved.id)

    expect(readHomeBoard()).toBeNull()
    expect(resolveHomeBoard(readBoards())?.id).toBe(saved.id)
  })

  it('clears temporary cover data with the rest of local state', () => {
    writeHomeBoard(board('draft', 'P2', [bus('藍1', 'R2')]))
    clearHomeBoard()
    expect(local.getItem(HOME_KEY)).toBeNull()

    writeHomeBoard(board('draft', 'P2', [bus('藍1', 'R2')]))
    clearLocalData()
    expect(local.getItem(HOME_KEY)).toBeNull()
  })
})

describe('TDX browser credential lifecycle', () => {
  const auth: TdxAuth = { clientId: 'client-id', clientSecret: 'client-secret' }
  let local: MemoryStorage
  let session: MemoryStorage

  beforeEach(() => {
    local = new MemoryStorage()
    session = new MemoryStorage()
    vi.stubGlobal('localStorage', local)
    vi.stubGlobal('sessionStorage', session)
    resetTdxAuthMemoryForTests()
  })

  afterEach(() => {
    resetTdxAuthMemoryForTests()
    vi.unstubAllGlobals()
  })

  it('stores new credentials in the current tab by default', () => {
    setTdxAuth(auth)

    expect(JSON.parse(session.getItem(SESSION_KEY) ?? 'null')).toEqual(auth)
    expect(local.getItem(DEVICE_KEY)).toBeNull()
    expect(getTdxAuthState()).toEqual({ auth, persistence: 'session' })
  })

  it('uses localStorage only after explicit device opt-in', () => {
    setTdxAuth(auth, 'device')
    resetTdxAuthMemoryForTests()

    expect(JSON.parse(local.getItem(DEVICE_KEY) ?? 'null')).toEqual(auth)
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(getTdxAuthState()).toEqual({ auth, persistence: 'device' })
  })

  it('moves legacy long-lived credentials into the current session', () => {
    local.setItem(LEGACY_KEY, JSON.stringify(auth))

    expect(getTdxAuthState()).toEqual({ auth, persistence: 'session' })
    expect(local.getItem(LEGACY_KEY)).toBeNull()
    expect(JSON.parse(session.getItem(SESSION_KEY) ?? 'null')).toEqual(auth)
    expect(consumeTdxAuthMigrationNotice()).toBe(true)
    expect(consumeTdxAuthMigrationNotice()).toBe(false)
  })

  it('switches storage modes without leaving a second secret copy', () => {
    setTdxAuth(auth, 'device')
    setTdxAuth(auth, 'session')
    expect(local.getItem(DEVICE_KEY)).toBeNull()
    expect(session.getItem(SESSION_KEY)).not.toBeNull()

    setTdxAuth(auth, 'device')
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(local.getItem(DEVICE_KEY)).not.toBeNull()
  })

  it('rejects malformed or oversized stored credentials', () => {
    session.setItem(SESSION_KEY, JSON.stringify({ clientId: 'id', clientSecret: '' }))
    local.setItem(DEVICE_KEY, JSON.stringify({ clientId: 'x'.repeat(121), clientSecret: 'secret' }))

    expect(getTdxAuthState()).toEqual({ auth: null, persistence: null })
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(local.getItem(DEVICE_KEY)).toBeNull()
  })

  it('falls back to page memory when sessionStorage is denied', () => {
    vi.stubGlobal('sessionStorage', new DeniedStorage())
    setTdxAuth(auth)

    expect(getTdxAuthState()).toEqual({ auth, persistence: 'session' })
    expect(() => setTdxAuth(auth, 'device')).not.toThrow()
  })

  it('does not pretend device persistence succeeded when localStorage is denied', () => {
    vi.stubGlobal('localStorage', new DeniedStorage())

    expect(() => setTdxAuth(auth, 'device')).toThrow('瀏覽器無法長期保存憑證')
  })

  it('does not claim session-only mode when the persistent copy cannot be removed', () => {
    const lockedLocal = new RemoveDeniedStorage()
    lockedLocal.setItem(DEVICE_KEY, JSON.stringify(auth))
    vi.stubGlobal('localStorage', lockedLocal)

    expect(() => setTdxAuth(auth, 'session')).toThrow('無法清除原本長期保存的憑證')
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(lockedLocal.getItem(DEVICE_KEY)).not.toBeNull()
  })

  it('clears legacy, session, device, and every appearance schema together', () => {
    local.setItem(LEGACY_KEY, JSON.stringify(auth))
    local.setItem(DEVICE_KEY, JSON.stringify(auth))
    local.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify({ version: 3, general: 'light', map: 'dark' }))
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) local.setItem(key, '{}')
    session.setItem(SESSION_KEY, JSON.stringify(auth))

    clearTdxAuth()
    expect(local.getItem(LEGACY_KEY)).toBeNull()
    expect(local.getItem(DEVICE_KEY)).toBeNull()
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(getTdxAuthState()).toEqual({ auth: null, persistence: null })

    setTdxAuth(auth, 'device')
    clearLocalData()
    expect(local.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) expect(local.getItem(key)).toBeNull()
    expect(getTdxAuthState()).toEqual({ auth: null, persistence: null })
  })
})
