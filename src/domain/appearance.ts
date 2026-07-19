export type AppearanceTheme = 'light' | 'dark'
export type AppearancePage = 'general' | 'map'

export type AppearancePreferences = {
  version: 3
  general: AppearanceTheme
  map: AppearanceTheme
}

type LegacyAppearancePreferences = {
  version?: unknown
  general?: unknown
  home?: unknown
  map?: unknown
  mapUi?: unknown
  mapTiles?: unknown
}

export const APPEARANCE_STORAGE_KEY = 'mochi.bus.appearance.v3'
export const LEGACY_APPEARANCE_STORAGE_KEYS = [
  'mochi.bus.appearance.v2',
  'mochi.bus.appearance.v1',
] as const
export const LOCAL_DATA_CLEARED_EVENT = 'mochi:local-data-cleared'

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 3,
  general: 'dark',
  map: 'light',
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_APPEARANCE }
  const candidate = value as LegacyAppearancePreferences
  return {
    version: 3,
    general: isAppearanceTheme(candidate.general)
      ? candidate.general
      : isAppearanceTheme(candidate.home)
        ? candidate.home
        : DEFAULT_APPEARANCE.general,
    // v2 allowed mismatched map UI and basemap themes. Preserve the interface choice
    // because it determines readability, then fall back to the basemap if needed.
    map: isAppearanceTheme(candidate.map)
      ? candidate.map
      : isAppearanceTheme(candidate.mapUi)
        ? candidate.mapUi
        : isAppearanceTheme(candidate.mapTiles)
          ? candidate.mapTiles
          : DEFAULT_APPEARANCE.map,
  }
}

export function appearancePageForPath(pathname: string): AppearancePage {
  return pathname === '/map' || pathname.startsWith('/map/') ? 'map' : 'general'
}

export function appearanceThemeColor(
  page: AppearancePage,
  preferences: AppearancePreferences,
): string {
  if (page === 'map') return preferences.map === 'dark' ? '#1d1c19' : '#e8e2d6'
  return preferences.general === 'dark' ? '#211f1b' : '#f7f2e8'
}

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'light' || value === 'dark'
}
