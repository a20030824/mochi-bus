import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
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
  it('defaults to a dark homepage with a light map interface and basemap', () => {
    expect(readAppearancePreferences(new MemoryStorage())).toEqual(DEFAULT_APPEARANCE)
  })

  it('repairs each malformed field independently', () => {
    expect(normalizeAppearancePreferences({
      version: 999,
      home: 'light',
      mapUi: 'sepia',
      mapTiles: 'dark',
    })).toEqual({
      version: 1,
      home: 'light',
      mapUi: 'light',
      mapTiles: 'dark',
    })
  })

  it('persists one versioned object and can clear it', () => {
    const storage = new MemoryStorage()
    writeAppearancePreferences({ version: 1, home: 'light', mapUi: 'dark', mapTiles: 'dark' }, storage)

    expect(JSON.parse(storage.getItem(APPEARANCE_STORAGE_KEY) ?? 'null')).toEqual({
      version: 1,
      home: 'light',
      mapUi: 'dark',
      mapTiles: 'dark',
    })
    expect(readAppearancePreferences(storage).mapUi).toBe('dark')

    clearAppearancePreferences(storage)
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })

  it('removes corrupted JSON instead of throwing during page bootstrap', () => {
    const storage = new MemoryStorage()
    storage.setItem(APPEARANCE_STORAGE_KEY, '{bad json')

    expect(readAppearancePreferences(storage)).toEqual(DEFAULT_APPEARANCE)
    expect(storage.getItem(APPEARANCE_STORAGE_KEY)).toBeNull()
  })
})
