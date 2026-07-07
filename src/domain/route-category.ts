export type RouteCategory = '數字' | '幹線' | '接駁' | '幸福／社區' | '觀光' | '小黃' | '公路客運' | '其他'

export function classifyRouteName(name: string, routeUid?: string): RouteCategory {
  // 公路客運(公路總局主管)的 UID 固定 THB 開頭;路名多是 4 位數字,
  // 靠名字會全部混進「數字」,所以用 UID 判斷、且要在數字規則之前。
  if (routeUid?.startsWith('THB')) return '公路客運'
  if (name.includes('台灣好行') || name.includes('觀光')) return '觀光'
  if (name.includes('幸福') || name.includes('樂活') || name.includes('社區')) return '幸福／社區'
  if (name.includes('小黃')) return '小黃'
  if (name.includes('幹線')) return '幹線'
  if (/^[紅藍綠棕橘黃小F]/u.test(name)) return '接駁'
  if (/^[0-9０-９]/u.test(name)) return '數字'
  return '其他'
}
