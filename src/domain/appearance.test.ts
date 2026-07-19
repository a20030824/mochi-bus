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

  it('migrates the old homepage field into the general interface field', () => {
    expect(normalizeAppearancePreferences({
      version: 1,
      home: 'light',
      mapUi: 'dark',
      mapTiles: 'light',
    })).toEqual({
      version: 2,
      general: 'light',
      mapUi: 'dark',
      mapTiles: 'light',
    })
  })

  it('derives browser chrome colors from the current page surface', () => {
    expect(appearanceThemeColor('general', DEFAULT_APPEARANCE)).toBe('#211f1b')
    expect(appearanceThemeColor('map', DEFAULT_APPEARANCE)).toBe('#e8e2d6')
    expect(appearanceThemeColor('map', { ...DEFAULT_APPEARANCE, mapUi: 'dark' })).toBe('#1d1c19')
  })
})
