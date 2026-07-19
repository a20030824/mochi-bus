import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  LEGACY_APPEARANCE_STORAGE_KEY,
} from './domain/appearance'
import { appearanceStyles } from './ui/appearance-styles'

const APPEARANCE_STYLE_ID = 'mochi-appearance-overrides'
const APPEARANCE_SCRIPT_SRC = '/assets/appearance.js'

export function applyAppearanceShell(response: Response): Response {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/html') || typeof HTMLRewriter === 'undefined') return response

  const headMarkup = `<style id="${APPEARANCE_STYLE_ID}">${appearanceStyles}</style><script>${appearancePrepaintScript()}</script>`
  const bodyMarkup = `<script type="module" src="${APPEARANCE_SCRIPT_SRC}"></script>`

  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(headMarkup, { html: true })
      },
    })
    .on('body', {
      element(element) {
        element.prepend(bodyMarkup, { html: true })
      },
    })
    .transform(response)
}

export function appearancePrepaintScript(): string {
  const storageKey = JSON.stringify(APPEARANCE_STORAGE_KEY)
  const legacyStorageKey = JSON.stringify(LEGACY_APPEARANCE_STORAGE_KEY)
  const defaults = JSON.stringify(DEFAULT_APPEARANCE)

  return `(function(){var d=${defaults};var p=d;try{var r=localStorage.getItem(${storageKey})||localStorage.getItem(${legacyStorageKey});if(r){var v=JSON.parse(r);var g=v&&v.general==='light'?'light':v&&v.general==='dark'?'dark':v&&v.home==='light'?'light':v&&v.home==='dark'?'dark':d.general;p={version:2,general:g,mapUi:v&&v.mapUi==='dark'?'dark':v&&v.mapUi==='light'?'light':d.mapUi,mapTiles:v&&v.mapTiles==='dark'?'dark':v&&v.mapTiles==='light'?'light':d.mapTiles};}}catch(e){}var root=document.documentElement;var page=location.pathname==='/map'||location.pathname.indexOf('/map/')===0?'map':'general';root.dataset.appearancePage=page;root.dataset.generalTheme=p.general;root.dataset.mapUiTheme=p.mapUi;root.dataset.mapTilesTheme=p.mapTiles;var color=page==='map'?(p.mapUi==='dark'?'#1d1c19':'#e8e2d6'):(p.general==='dark'?'#211f1b':'#f7f2e8');document.querySelectorAll('meta[name="theme-color"]').forEach(function(meta){meta.setAttribute('content',color);});}());`
}
