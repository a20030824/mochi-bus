export type AppearanceTheme = 'light' | 'dark'

export type AppearancePreferences = {
  version: 1
  home: AppearanceTheme
  mapUi: AppearanceTheme
  mapTiles: AppearanceTheme
}

export const APPEARANCE_STORAGE_KEY = 'mochi.bus.appearance.v1'

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 1,
  home: 'dark',
  mapUi: 'light',
  mapTiles: 'light',
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_APPEARANCE }
  const candidate = value as Partial<AppearancePreferences>
  return {
    version: 1,
    home: isAppearanceTheme(candidate.home) ? candidate.home : DEFAULT_APPEARANCE.home,
    mapUi: isAppearanceTheme(candidate.mapUi) ? candidate.mapUi : DEFAULT_APPEARANCE.mapUi,
    mapTiles: isAppearanceTheme(candidate.mapTiles) ? candidate.mapTiles : DEFAULT_APPEARANCE.mapTiles,
  }
}

export function readAppearancePreferences(storage: Storage | undefined = browserStorage()): AppearancePreferences {
  const raw = safeGet(storage, APPEARANCE_STORAGE_KEY)
  if (raw === null) return { ...DEFAULT_APPEARANCE }
  try {
    return normalizeAppearancePreferences(JSON.parse(raw) as unknown)
  } catch {
    safeRemove(storage, APPEARANCE_STORAGE_KEY)
    return { ...DEFAULT_APPEARANCE }
  }
}

export function writeAppearancePreferences(
  value: AppearancePreferences,
  storage: Storage | undefined = browserStorage(),
): AppearancePreferences {
  const normalized = normalizeAppearancePreferences(value)
  safeSet(storage, APPEARANCE_STORAGE_KEY, JSON.stringify(normalized))
  return normalized
}

export function clearAppearancePreferences(storage: Storage | undefined = browserStorage()): void {
  safeRemove(storage, APPEARANCE_STORAGE_KEY)
}

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'light' || value === 'dark'
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
