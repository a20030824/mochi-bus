import { describe, expect, it } from 'vitest'
import { renderMapPage } from './map-page'
import { siteSearchDescription, siteSocialDescription, siteSocialImage, siteTitle } from './seo'
import { renderETAPage, renderSetupPage } from './ui'

const query = {
  city: 'Taipei',
  routeName: '307',
  stopName: '捷運西門站',
  stopUid: 'TPE213044',
  direction: 0 as const,
}

describe('SEO metadata', () => {
  it('renders homepage title, description, and site-name structured data', () => {
    const html = renderETAPage({ query, useLocalBoard: true })

    expect(html).toContain(`<title>${siteTitle}</title>`)
    expect(html).toContain(`<meta name="description" content="${siteSearchDescription}">`)
    expect(html).toContain(`<meta property="og:description" content="${siteSocialDescription}">`)
    expect(html).toContain('<meta property="og:site_name" content="Mochi Bus">')
    expect(html).toContain('<link rel="icon" href="/icon.svg" type="image/svg+xml">')
    expect(html).toContain('<link rel="icon" href="/favicon.ico" sizes="any">')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png">')
    expect(html).toContain('<script type="application/ld+json">')
    expect(html).toContain('"@type":"WebSite"')
    expect(html).toContain('"name":"Mochi Bus"')
    expect(html).toContain('"alternateName":"Mochi Bus 台灣公車地圖"')
  })

  it('renders one semantic heading for the ETA page', () => {
    const html = renderETAPage({ query, useLocalBoard: false })

    expect(html).toContain('<h1 class="eyebrow" id="board-title">307 在 捷運西門站 的到站時間</h1>')
  })

  it('renders a server-side heading for map pages', () => {
    const html = renderMapPage({ heading: '台北市公車地圖' })

    expect(html).toContain('<h1 class="map-page-title">台北市公車地圖</h1>')
  })

  it('makes persistent BYOK storage an explicit setup-page opt-in', () => {
    const html = renderSetupPage([['Taipei', '臺北']])

    expect(html).toContain('<label for="tdx-client-id">Client ID</label>')
    expect(html).toContain('<label for="tdx-client-secret">Client Secret</label>')
    expect(html).toContain('id="tdx-remember" type="checkbox"')
    expect(html).toContain('否則關閉本分頁後即移除')
  })

  // 互動邏輯(記住於此裝置 vs 只保留在此分頁、legacy migration 提示)已搬到
  // web/setup/main.ts,交給 Vite 建置與 TypeScript 檢查(ARCH-001);伺服器只
  // 負責掛上建好的 script,不再把行為字串直接嵌進 HTML 裡斷言。
  it('loads the setup page interactivity as a built module script, not an inline literal', () => {
    const html = renderSetupPage([['Taipei', '臺北']])

    expect(html).toContain('<script type="module" src="/assets/setup.js"></script>')
    expect(html).not.toContain("tdxRemember.checked?'device':'session'")
  })

  it('keeps the setup page (per-device local data) out of search indexes', () => {
    const html = renderSetupPage([['Taipei', '臺北']])

    expect(html).toContain('<meta name="robots" content="noindex">')
  })

  it('does not noindex the shareable ETA and map pages', () => {
    expect(renderETAPage({ query, useLocalBoard: true })).not.toContain('name="robots"')
    expect(renderMapPage({ heading: '台北市公車地圖' })).not.toContain('name="robots"')
  })

  it('gives chat-app link previews an image and Twitter Card metadata', () => {
    const eta = renderETAPage({ query, useLocalBoard: true })
    const map = renderMapPage({ heading: '台北市公車地圖' })

    for (const html of [eta, map]) {
      expect(html).toContain(`<meta property="og:image" content="${siteSocialImage}">`)
      expect(html).toContain('<meta name="twitter:card" content="summary">')
      expect(html).toContain(`<meta name="twitter:description" content="${siteSocialDescription}">`)
      expect(html).toContain(`<meta name="twitter:image" content="${siteSocialImage}">`)
    }
  })
})
