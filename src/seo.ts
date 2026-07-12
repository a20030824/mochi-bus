export const siteName = 'Mochi Bus'
export const siteOrigin = 'https://bus.moc96336.com'
export const siteTitle = 'Mochi Bus｜台灣公車地圖與到站看板'
export const siteSearchDescription = '台灣公車地圖與到站看板。查看常用站牌到站時間、探索全城路網、站牌路線與即時車輛位置。'
export const siteSocialDescription = '先看懂城市的公車路網，再決定怎麼搭車。'
// 目前唯一現成的方形圖:180x180 的 app icon。當作 og:image/twitter:image 的
// 保底,聊天軟體預覽卡至少有圖示可看;要換成 1200x630 的橫向 banner 需要
// 額外設計,不在這輪範圍內。
export const siteSocialImage = `${siteOrigin}/apple-touch-icon.png`

// canonical/og:url 一律標準化成正式網域:即使請求進來的 Host 是本機開發、
// preview 或 workers.dev,分享卡與搜尋引擎看到的網址都得是同一個,
// 才不會替內容做出好幾個互相競爭的索引目標。
export function canonicalUrl(requestUrl: string): string {
  const url = new URL(requestUrl)
  return `${siteOrigin}${url.pathname}${url.search}`
}

const websiteStructuredData = {
  '@context': 'https://schema.org',
  '@type': 'WebSite',
  name: siteName,
  alternateName: 'Mochi Bus 台灣公車地圖',
  url: 'https://bus.moc96336.com/',
  description: siteSearchDescription,
  inLanguage: 'zh-TW',
}

export function renderWebsiteStructuredData(): string {
  return `<script type="application/ld+json">${JSON.stringify(websiteStructuredData)}</script>`
}
