// 路線視圖的「退路」決策:同一個畫面可能從路線列表、站牌路線、
// 行程候選、支線選擇四種入口進來,返回鍵與「更換」按鈕必須退回對的那一層。
// 這裡只做純決策(狀態 → 退到哪一層 + 按鈕文字),實際導航由 UI 端對應執行;
// 之前的五個導航陷阱都是這個矩陣寫岔了,抽出來讓測試把每一格釘死。
export type RouteBackContext = {
  // 這條路線是從行程候選清單點進來的
  returnToTrip: boolean
  // 行程候選結果目前還在(起終點與候選清單都沒被丟棄)
  hasTripResults: boolean
  // 是經過支線選擇畫面進來的,而且同一路線的支線清單還在
  canReturnToVariantPicker: boolean
  // 有指定的站點退路(從站牌路線清單點進來)
  hasStopBackAction: boolean
}

export type RouteBackTarget = 'trip-results' | 'variant-picker' | 'stop-view' | 'route-picker'

export type RouteBackDecision = {
  target: RouteBackTarget
  label: string
}

// 路線「載入中/載入失敗/支線選擇」時的退路:這個階段還沒有支線可換,
// 優先序是行程候選 > 站點 > 路線列表。
export function routeLoadingBack(context: Pick<RouteBackContext, 'returnToTrip' | 'hasStopBackAction'>): RouteBackDecision {
  if (context.returnToTrip) return { target: 'trip-results', label: '返回行程候選' }
  if (context.hasStopBackAction) return { target: 'stop-view', label: '返回站點' }
  return { target: 'route-picker', label: '返回路線' }
}

// 路線畫好之後的退路。標籤依進入方式決定;實際目標多一層防呆:
// 行程候選已被丟棄時(returnToTrip 但 hasTripResults 為 false)退回站點或路線列表。
export function routeViewBack(context: RouteBackContext): RouteBackDecision {
  const label = context.returnToTrip
    ? '返回行程候選'
    : context.canReturnToVariantPicker
      ? '更換方向'
      : context.hasStopBackAction ? '返回站點' : '更換路線'
  const target: RouteBackTarget = context.returnToTrip && context.hasTripResults
    ? 'trip-results'
    // 從支線選擇進來的,退回支線選擇(一層);直接跳路線列表會一次退兩層。
    : context.canReturnToVariantPicker
      ? 'variant-picker'
      : context.hasStopBackAction ? 'stop-view' : 'route-picker'
  return { target, label }
}
