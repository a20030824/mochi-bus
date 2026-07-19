import {
  readAppearancePreferences,
  writeAppearancePreferences,
  type AppearancePreferences,
  type AppearanceTheme,
} from './preferences'
import { appearanceStyles } from './styles'

const STYLE_ID = 'mochi-appearance-overrides'
const SETTINGS_ID = 'appearance-settings'

type AppearanceKey = 'home' | 'mapUi' | 'mapTiles'

type AppearanceOption = {
  key: AppearanceKey
  id: string
  label: string
}

const appearanceOptions: AppearanceOption[] = [
  { key: 'home', id: 'appearance-home', label: '首頁外觀' },
  { key: 'mapUi', id: 'appearance-map-ui', label: '地圖介面' },
  { key: 'mapTiles', id: 'appearance-map-tiles', label: '地圖底圖' },
]

export function applyStoredAppearance(): AppearancePreferences {
  const preferences = readAppearancePreferences()
  const root = document.documentElement
  root.dataset.homeTheme = preferences.home
  root.dataset.mapUiTheme = preferences.mapUi
  root.dataset.mapTilesTheme = preferences.mapTiles
  root.dataset.appearancePage = appearancePage()
  installAppearanceStyles()
  updateThemeColor(preferences)
  if (location.pathname === '/setup') installAppearanceSettings(preferences)
  return preferences
}

function appearancePage(): 'home' | 'map' | 'other' {
  if (location.pathname === '/') return 'home'
  if (location.pathname === '/map') return 'map'
  return 'other'
}

function updateThemeColor(preferences: AppearancePreferences): void {
  const page = appearancePage()
  const theme = page === 'home' ? preferences.home : page === 'map' ? preferences.mapUi : undefined
  if (!theme) return
  const color = theme === 'dark' ? '#211f1b' : '#f7f2e8'
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = color
  })
}

function installAppearanceStyles(): void {
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = appearanceStyles
  document.head.appendChild(style)
}

function installAppearanceSettings(initial: AppearancePreferences): void {
  if (document.getElementById(SETTINGS_ID)) return
  const advanced = document.querySelector('.advanced-panel') as HTMLDetailsElement | null
  if (!advanced) return

  let preferences = initial
  const section = document.createElement('div')
  section.id = SETTINGS_ID
  section.className = 'advanced-section appearance-section'

  const details = document.createElement('details')
  details.className = 'glossary appearance-panel'
  const summary = document.createElement('summary')
  summary.textContent = '外觀'

  const list = document.createElement('div')
  list.className = 'appearance-list'

  const announcement = document.createElement('p')
  announcement.className = 'form-message appearance-message'
  announcement.setAttribute('aria-live', 'polite')

  const controls = new Map<AppearanceKey, { input: HTMLInputElement; value: HTMLElement }>()
  for (const option of appearanceOptions) {
    const row = document.createElement('label')
    row.className = 'appearance-row'
    row.htmlFor = option.id

    const copy = document.createElement('span')
    copy.className = 'appearance-copy'
    const label = document.createElement('strong')
    label.textContent = option.label
    const value = document.createElement('small')
    value.id = `${option.id}-value`
    copy.replaceChildren(label, value)

    const input = document.createElement('input')
    input.id = option.id
    input.className = 'appearance-switch'
    input.type = 'checkbox'
    input.setAttribute('role', 'switch')
    input.setAttribute('aria-describedby', value.id)
    input.checked = preferences[option.key] === 'dark'
    updateControlText(input, value)

    input.addEventListener('change', () => {
      const theme: AppearanceTheme = input.checked ? 'dark' : 'light'
      preferences = writeAppearancePreferences({ ...preferences, [option.key]: theme })
      updateControlText(input, value)
      announcement.textContent = `${option.label}已改為${themeLabel(theme)}。`
    })

    controls.set(option.key, { input, value })
    row.replaceChildren(copy, input)
    list.appendChild(row)
  }

  details.replaceChildren(summary, list, announcement)
  section.appendChild(details)
  const firstSection = advanced.querySelector(':scope > .advanced-section')
  advanced.insertBefore(section, firstSection)

  // Browser back/forward cache may restore the DOM while storage changed in another tab.
  window.addEventListener('pageshow', () => {
    preferences = readAppearancePreferences()
    for (const option of appearanceOptions) {
      const control = controls.get(option.key)
      if (!control) continue
      control.input.checked = preferences[option.key] === 'dark'
      updateControlText(control.input, control.value)
    }
  })
}

function updateControlText(input: HTMLInputElement, value: HTMLElement): void {
  const theme: AppearanceTheme = input.checked ? 'dark' : 'light'
  input.setAttribute('aria-checked', String(input.checked))
  value.textContent = themeLabel(theme)
}

function themeLabel(theme: AppearanceTheme): string {
  return theme === 'dark' ? '深色' : '淺色'
}

applyStoredAppearance()
