import { describe, expect, it } from 'vitest'
import { renderMapPage } from './map-page'
import { siteSearchDescription, siteSocialDescription, siteTitle } from './seo'
import { renderETAPage } from './ui'

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
})
