export const siteName = 'Mochi Bus'
export const siteTitle = 'Mochi Bus｜台灣公車地圖與到站看板'
export const siteSearchDescription = '台灣公車地圖與到站看板。查看常用站牌到站時間、探索全城路網、站牌路線與即時車輛位置。'
export const siteSocialDescription = '先看懂城市的公車路網，再決定怎麼搭車。'

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
