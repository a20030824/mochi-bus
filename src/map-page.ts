import { canonicalUrl, renderWebsiteStructuredData, siteOrigin, siteSearchDescription, siteSocialDescription, siteSocialImage, siteTitle } from './seo'

export type MapPageMeta = {
  title?: string
  description?: string
  heading?: string
  requestUrl?: string
}

// 深連結(?route= / ?city=)由伺服器端組標題:社群/聊天軟體的爬蟲不跑 JS,
// SSR 給對標題,分享出去的預覽卡才看得出是哪條路線;頁內切換另由前端更新 document.title。
export function renderMapPage(meta: MapPageMeta = {}): string {
  const title = meta.title ?? siteTitle
  const description = meta.description ?? siteSearchDescription
  const heading = meta.heading ?? '台灣公車地圖'
  const canonical = meta.requestUrl ? canonicalUrl(meta.requestUrl) : `${siteOrigin}/map`
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
  <meta name="theme-color" content="#e8e2d6" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#1d1c19" media="(prefers-color-scheme: dark)">
  <meta name="description" content="${escapeHTML(description)}">
  <link rel="canonical" href="${escapeHTML(canonical)}">
  <meta property="og:title" content="${escapeHTML(title)}">
  <meta property="og:description" content="${escapeHTML(siteSocialDescription)}">
  <meta property="og:site_name" content="Mochi Bus">
  <meta property="og:url" content="${escapeHTML(canonical)}">
  <meta property="og:image" content="${siteSocialImage}">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHTML(title)}">
  <meta name="twitter:description" content="${escapeHTML(siteSocialDescription)}">
  <meta name="twitter:image" content="${siteSocialImage}">
  ${renderWebsiteStructuredData()}
  <link rel="manifest" href="/manifest.webmanifest">
  <link rel="icon" href="/icon.svg" type="image/svg+xml">
  <link rel="icon" href="/favicon.ico" sizes="any">
  <link rel="apple-touch-icon" href="/apple-touch-icon.png">
  <title>${escapeHTML(title)}</title>
  <link rel="stylesheet" href="/assets/map.css">
  <link rel="modulepreload" href="/assets/map.js">
  <link rel="modulepreload" href="/assets/boards.js">
  <link rel="preconnect" href="https://tile.openstreetmap.org" crossorigin>
</head>
<body>
  <div id="map-app">
    <h1 class="map-page-title">${escapeHTML(heading)}</h1>
    <div id="map" aria-label="公車路線地圖"></div>
    <header class="map-header">
      <a id="map-brand" href="/map" class="map-brand" title="回到全台總覽">MOCHI <span>MAP</span></a>
      <a class="quiet-button map-home" href="/">首頁</a>
    </header>
    <div id="map-status" class="map-status" aria-live="polite">選一個區域，看看公車如何穿過城市。</div>
    <aside id="map-drawer" class="map-drawer" aria-live="polite"></aside>
  </div>
  <script type="module" src="/assets/map.js"></script>
</body>
</html>`
}

function escapeHTML(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
}
