import { describe, expect, it } from 'vitest'
import {
  appearancePageForPath,
  appearanceThemeColor,
  DEFAULT_APPEARANCE,
  normalizeAppearancePreferences,
} from './appearance'

describe('appearance domain', () => {
  it('treats only the map shell as map-specific', () => {
    expect(appearancePageForPath('/map')).toBe('map')
    expect(appearancePageForPath('/map/')).toBe('map')
    for (const path of ['/', '/setup', '/bus', '/route', '/missing']) {
      expect(appearancePageForPath(path)).toBe('general')
    }
  })

  it('migrates v1 fields into general and unified map preferences', () => {
    expect(normalizeAppearancePreferences({
      version: 1,
      home: 'light',
      mapUi: 'dark',
      mapTiles: 'light',
    })).toEqual({
      version: 3,
      general: 'light',
      map: 'dark',
    })
  })

  it('uses the v2 interface theme when interface and basemap disagree', () => {
    expect(normalizeAppearancePreferences({
      version: 2,
      general: 'dark',
      mapUi: 'light',
      mapTiles: 'dark',
    })).toEqual({
      version: 3,
      general: 'dark',
      map: 'light',
    })
  })

  it('derives browser chrome colors from the current page surface', () => {
    expect(appearanceThemeColor('general', DEFAULT_APPEARANCE)).toBe('#211f1b')
    expect(appearanceThemeColor('map', DEFAULT_APPEARANCE)).toBe('#e8e2d6')
    expect(appearanceThemeColor('map', { ...DEFAULT_APPEARANCE, map: 'dark' })).toBe('#1d1c19')
  })
})
