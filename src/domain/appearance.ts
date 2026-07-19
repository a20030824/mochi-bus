export type AppearanceTheme = 'light' | 'dark'
export type AppearancePage = 'general' | 'map'

export type AppearancePreferences = {
  version: 2
  general: AppearanceTheme
  mapUi: AppearanceTheme
  mapTiles: AppearanceTheme
}

type LegacyAppearancePreferences = {
  version?: unknown
  home?: unknown
  mapUi?: unknown
  mapTiles?: unknown
}

export const APPEARANCE_STORAGE_KEY = 'mochi.bus.appearance.v2'
export const LEGACY_APPEARANCE_STORAGE_KEY = 'mochi.bus.appearance.v1'
export const LOCAL_DATA_CLEARED_EVENT = 'mochi:local-data-cleared'

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  version: 2,
  general: 'dark',
  mapUi: 'light',
  mapTiles: 'light',
}

export function normalizeAppearancePreferences(value: unknown): AppearancePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_APPEARANCE }
  const candidate = value as Partial<AppearancePreferences> & LegacyAppearancePreferences
  return {
    version: 2,
    general: isAppearanceTheme(candidate.general)
      ? candidate.general
      : isAppearanceTheme(candidate.home)
        ? candidate.home
        : DEFAULT_APPEARANCE.general,
    mapUi: isAppearanceTheme(candidate.mapUi) ? candidate.mapUi : DEFAULT_APPEARANCE.mapUi,
    mapTiles: isAppearanceTheme(candidate.mapTiles) ? candidate.mapTiles : DEFAULT_APPEARANCE.mapTiles,
  }
}

export function appearancePageForPath(pathname: string): AppearancePage {
  return pathname === '/map' || pathname.startsWith('/map/') ? 'map' : 'general'
}

export function appearanceThemeColor(
  page: AppearancePage,
  preferences: AppearancePreferences,
): string {
  if (page === 'map') return preferences.mapUi === 'dark' ? '#1d1c19' : '#e8e2d6'
  return preferences.general === 'dark' ? '#211f1b' : '#f7f2e8'
}

function isAppearanceTheme(value: unknown): value is AppearanceTheme {
  return value === 'light' || value === 'dark'
}
