import {
  APPEARANCE_STORAGE_KEY,
  appearancePageForPath,
  appearanceThemeColor,
  LEGACY_APPEARANCE_STORAGE_KEY,
  LOCAL_DATA_CLEARED_EVENT,
  type AppearancePage,
} from '../../src/domain/appearance'
import {
  readAppearancePreferences,
  writeAppearancePreferences,
  type AppearancePreferences,
  type AppearanceTheme,
} from './preferences'
import { appearanceSettingsStyles } from './settings-styles'
import { appearanceStyles } from './styles'

const STYLE_ID = 'mochi-appearance-overrides'
const SETTINGS_STYLE_ID = 'mochi-appearance-settings'
const SETTINGS_ID = 'appearance-settings'

type AppearanceKey = 'general' | 'mapUi' | 'mapTiles'

type AppearanceOption = {
  key: AppearanceKey
  id: string
  label: string
}

type AppearanceControl = Record<AppearanceTheme, HTMLInputElement>

const themes: AppearanceTheme[] = ['light', 'dark']
const appearanceOptions: AppearanceOption[] = [
  { key: 'general', id: 'appearance-general', label: '一般介面' },
  { key: 'mapUi', id: 'appearance-map-ui', label: '地圖介面' },
  { key: 'mapTiles', id: 'appearance-map-tiles', label: '地圖底圖' },
]

let syncAppearanceSettings: ((preferences: AppearancePreferences) => void) | undefined

export function applyStoredAppearance(): AppearancePreferences {
  const preferences = readAppearancePreferences()
  applyAppearance(preferences)
  return preferences
}

function applyAppearance(preferences: AppearancePreferences): void {
  const page = appearancePage()
  const root = document.documentElement
  root.dataset.appearancePage = page
  root.dataset.generalTheme = preferences.general
  root.dataset.mapUiTheme = preferences.mapUi
  root.dataset.mapTilesTheme = preferences.mapTiles
  installAppearanceStyles()
  updateThemeColor(page, preferences)
  if (location.pathname === '/setup') {
    installAppearanceSettings(preferences)
    updateClearLocalDataCopy()
  }
}

function appearancePage(): AppearancePage {
  return appearancePageForPath(location.pathname)
}

function updateThemeColor(page: AppearancePage, preferences: AppearancePreferences): void {
  const color = appearanceThemeColor(page, preferences)
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((meta) => {
    meta.content = color
  })
}

function installAppearanceStyles(): void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style')
    style.id = STYLE_ID
    style.textContent = appearanceStyles
    document.head.appendChild(style)
  }
  if (location.pathname === '/setup' && !document.getElementById(SETTINGS_STYLE_ID)) {
    const style = document.createElement('style')
    style.id = SETTINGS_STYLE_ID
    style.textContent = appearanceSettingsStyles
    document.head.appendChild(style)
  }
}

function installAppearanceSettings(initial: AppearancePreferences): void {
  if (document.getElementById(SETTINGS_ID)) {
    syncAppearanceSettings?.(initial)
    return
  }
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

  const controls = new Map<AppearanceKey, AppearanceControl>()
  const syncControls = (next: AppearancePreferences) => {
    preferences = next
    for (const option of appearanceOptions) {
      const control = controls.get(option.key)
      if (control) control[preferences[option.key]].checked = true
    }
  }
  syncAppearanceSettings = syncControls

  for (const option of appearanceOptions) {
    const row = document.createElement('div')
    row.className = 'appearance-row'
    row.setAttribute('role', 'radiogroup')

    const label = document.createElement('strong')
    label.id = `${option.id}-label`
    label.className = 'appearance-label'
    label.textContent = option.label
    row.setAttribute('aria-labelledby', label.id)

    const segmented = document.createElement('div')
    segmented.className = 'appearance-segmented'
    const optionControls = {} as AppearanceControl

    for (const theme of themes) {
      const segment = document.createElement('label')
      segment.className = 'appearance-segment'

      const input = document.createElement('input')
      input.id = `${option.id}-${theme}`
      input.className = 'appearance-option-input'
      input.type = 'radio'
      input.name = option.id
      input.value = theme
      input.checked = preferences[option.key] === theme

      const text = document.createElement('span')
      text.textContent = themeLabel(theme)

      input.addEventListener('change', () => {
        if (!input.checked) return
        preferences = writeAppearancePreferences({ ...preferences, [option.key]: theme })
        applyAppearance(preferences)
        announcement.textContent = `${option.label}已改為${themeLabel(theme)}。`
      })

      optionControls[theme] = input
      segment.replaceChildren(input, text)
      segmented.appendChild(segment)
    }

    controls.set(option.key, optionControls)
    row.replaceChildren(label, segmented)
    list.appendChild(row)
  }

  details.replaceChildren(summary, list, announcement)
  section.appendChild(details)
  const firstSection = advanced.querySelector(':scope > .advanced-section')
  advanced.insertBefore(section, firstSection)
  syncControls(initial)
}

function updateClearLocalDataCopy(): void {
  const button = document.querySelector('#clear-local-button') as HTMLButtonElement | null
  const copy = button?.parentElement?.querySelector(':scope > p') as HTMLParagraphElement | null
  if (copy) copy.textContent = '常用站牌、封面設定、外觀與 TDX 憑證會一併刪除。'
}

function themeLabel(theme: AppearanceTheme): string {
  return theme === 'dark' ? '深色' : '淺色'
}

window.addEventListener('pageshow', applyStoredAppearance)
window.addEventListener('storage', (event) => {
  if (event.key === null || event.key === APPEARANCE_STORAGE_KEY || event.key === LEGACY_APPEARANCE_STORAGE_KEY) {
    applyStoredAppearance()
  }
})
window.addEventListener(LOCAL_DATA_CLEARED_EVENT, applyStoredAppearance)

applyStoredAppearance()
