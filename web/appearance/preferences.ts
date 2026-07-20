import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEYS,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from '../../src/domain/appearance'

export {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEYS,
  normalizeAppearancePreferences,
}
export type { AppearancePreferences, AppearanceTheme } from '../../src/domain/appearance'

export function readAppearancePreferences(storage: Storage | undefined = browserStorage()): AppearancePreferences {
  const current = safeGet(storage, APPEARANCE_STORAGE_KEY)
  if (current !== null) {
    try {
      return normalizeAppearancePreferences(JSON.parse(current) as unknown)
    } catch {
      safeRemove(storage, APPEARANCE_STORAGE_KEY)
    }
  }

  for (const legacyKey of LEGACY_APPEARANCE_STORAGE_KEYS) {
    const legacy = safeGet(storage, legacyKey)
    if (legacy === null) continue
    try {
      const normalized = normalizeAppearancePreferences(JSON.parse(legacy) as unknown)
      if (safeSet(storage, APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))) {
        clearLegacyAppearancePreferences(storage)
      }
      return normalized
    } catch {
      safeRemove(storage, legacyKey)
    }
  }

  return { ...DEFAULT_APPEARANCE }
}

export function writeAppearancePreferences(
  value: AppearancePreferences,
  storage: Storage | undefined = browserStorage(),
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(value)
  if (safeSet(storage, APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))) {
    clearLegacyAppearancePreferences(storage)
  }
  return normalized
}

export function clearAppearancePreferences(storage: Storage | undefined = browserStorage()): void {
  safeRemove(storage, APPEARANCE_STORAGE_KEY)
  clearLegacyAppearancePreferences(storage)
}

function clearLegacyAppearancePreferences(storage: Storage | undefined): void {
  for (const key of LEGACY_APPEARANCE_STORAGE_KEYS) safeRemove(storage, key)
}

function browserStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

function safeGet(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null
  } catch {
    return null
  }
}

function safeSet(storage: Storage | undefined, key: string, value: string): boolean {
  try {
    if (!storage) return false
    storage.setItem(key, value)
    return true
  } catch {
    return false
  }
}

function safeRemove(storage: Storage | undefined, key: string): boolean {
  try {
    if (!storage) return false
    storage.removeItem(key)
    return true
  } catch {
    return false
  }
}
