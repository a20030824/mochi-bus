import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEYS,
  clearAppearancePreferences,
  normalizeAppearancePreferences,
  readAppearancePreferences,
  writeAppearancePreferences,
} from './preferences'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number { return this.values.size }
  clear(): void { this.values.clear() }
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  key(index: number): string | null { return [...this.values.keys()][index] ?? null }
  removeItem(key: string): void { this.values.delete(key) }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

describe('appearance preferences', () => {
  it('defaults to a dark general interface with a light map appearance', () => {
    expect(readAppearancePreferences(new MemoryStorage())).toEqual(DEFAULT_APPEARANCE)
  })

  it('repairs malformed fields and prefers the old map interface theme', () => {
    expect(normalizeAppearancePreferences({
      version: 2,
      general: 'light',
      mapUi: 'sepia',
      mapTiles: 'dark',
    })).toEqual({
      version: 3,
      general: 'light',
      map: 'dark',
    })
  })

  it('migrates v2 into one map preference and removes both legacy copies', () => {
    const storage = new MemoryStorage()
    storage.setItem(LEGACY_APPEARANCE_STORAGE_KEYS[0], JSON.stringify({
      version: 2,
      general: 'light',
      mapUi: 'dark',
      mapTiles: 'light',
    }))
    storage.setItem(LEGACY_APPEARANCE_STORAGE_KEYS[1], JSON.stringify({
      version: 1,
      home: 'dark',
      mapUi: 'light',
      mapTiles: 'light',
    }))

    expect(readAppearancePreferences(storage)).toEqual({
      version: 3,
      general: 'light',
      map: 'dark',
    })
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) expect(storage.getItem(key)).toBeNull()
    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual({
      version: 3,
      general: 'light',
      map: 'dark',
    })
  })

  it('persists one versioned object and clears current and legacy copies', () => {
    const storage = new MemoryStorage()
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) storage.setItem(key, '{}')
    writeAppearancePreferences({ version: 3, general: 'light', map: 'dark' }, storage)

    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual({
      version: 3,
      general: 'light',
      map: 'dark',
    })
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) expect(storage.getItem(key)).toBeNull()

    clearAppearancePreferences(storage)
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
    for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) expect(storage.getItem(key)).toBeNull()
  })

  it('removes corrupted JSON instead of throwing during page bootstrap', () => {
    const storage = new MemoryStorage()
    storage.setItem(APPEARANCE_STORAGE_KEY, '{bad json')

    expect(readAppearancePreferences(storage)).toEqual(DEFAULT_APPEARANCE)
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })
})
