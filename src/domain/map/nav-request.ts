// 城市/路線/路網/附近站牌/地點/行程結果是互斥的 drawer 主視圖,同一個 view
// 在使用者連續操作下可能有兩個 fetch 同時在飛,先發的慢回應不能在後發的
// 快回應之後才落地覆蓋畫面。做法:每次使用者發起新的一輪導覽動作就 begin()
// 一次,拿到新 epoch 並 abort 前一輪還沒完成的 fetch;await 完成後只跟
// isStale() 比對,不同就是舊回應,安靜丟棄,不更新 store/DOM/URL,也不彈錯誤。
export type NavRequestCoordinator = {
  begin(): { requestId: number; signal: AbortSignal }
  isStale(requestId: number): boolean
}

export function createNavRequestCoordinator(): NavRequestCoordinator {
  let requestId = 0
  let controller: AbortController | undefined

  return {
    begin() {
      controller?.abort()
      controller = new AbortController()
      return { requestId: ++requestId, signal: controller.signal }
    },
    isStale(id: number) {
      return id !== requestId
    },
  }
}
