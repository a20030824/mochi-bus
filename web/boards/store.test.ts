import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearLocalData,
  clearTdxAuth,
  consumeTdxAuthMigrationNotice,
  getTdxAuthState,
  resetTdxAuthMemoryForTests,
  setTdxAuth,
  tdxHeaders,
  type TdxAuth,
} from './store'

const LEGACY_KEY = 'mochi.bus.tdxAuth.v1'
const SESSION_KEY = 'mochi.bus.tdxAuth.session.v2'
const DEVICE_KEY = 'mochi.bus.tdxAuth.device.v2'

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
    expect(tdxHeaders()).toEqual({
      'x-tdx-client-id': 'client-id',
      'x-tdx-client-secret': 'client-secret',
    })
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

  it('clears legacy, session, and device copies together', () => {
    local.setItem(LEGACY_KEY, JSON.stringify(auth))
    local.setItem(DEVICE_KEY, JSON.stringify(auth))
    session.setItem(SESSION_KEY, JSON.stringify(auth))

    clearTdxAuth()
    expect(local.getItem(LEGACY_KEY)).toBeNull()
    expect(local.getItem(DEVICE_KEY)).toBeNull()
    expect(session.getItem(SESSION_KEY)).toBeNull()
    expect(getTdxAuthState()).toEqual({ auth: null, persistence: null })

    setTdxAuth(auth, 'device')
    clearLocalData()
    expect(getTdxAuthState()).toEqual({ auth: null, persistence: null })
  })
})
