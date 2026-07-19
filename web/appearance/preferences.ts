import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
  normalizeAppearancePreferences,
  type AppearancePreferences,
} from '../../src/domain/appearance'

export {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
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

  const legacy = safeGet(storage, LEGACY_APPEARANCE_STORAGE_KEY)
  if (legacy === null) return { ...DEFAULT_APPEARANCE }
  try {
    const normalized = normalizeAppearancePreferences(JSON.parse(legacy) as unknown)
    if (safeSet(storage, APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))) {
      safeRemove(storage, LEGACY_APPEARANCE_STORAGE_KEY)
    }
    return normalized
  } catch {
    safeRemove(storage, LEGACY_APPEARANCE_STORAGE_KEY)
    return { ...DEFAULT_APPEARANCE }
  }
}

export function writeAppearancePreferences(
  value: AppearancePreferences,
  storage: Storage | undefined = browserStorage(),
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(value)
  if (safeSet(storage, APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))) {
    safeRemove(storage, LEGACY_APPEARANCE_STORAGE_KEY)
  }
  return normalized
}

export function clearAppearancePreferences(storage: Storage | undefined = browserStorage()): void {
  safeRemove(storage, APPEARANCE_STORAGE_KEY)
  safeRemove(storage, LEGACY_APPEARANCE_STORAGE_KEY)
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
