// 手機的返回鍵/返回手勢應該退回上一層畫面,不是直接離開整個地圖。
// 做法:只維護「一個」history 哨兵——離開根層時 push 一筆,
// popstate(使用者按返回)時執行目前畫面的返回動作,退完還沒到根層就再補推一筆。
// 各畫面照常用 replaceState 更新網址;哨兵只負責把「返回」這個動作攔下來。
// history 操作由呼叫端注入,這個模組保持純邏輯、可以被單元測試釘住。
export type SentinelHistory = {
  // 推入哨兵(history.pushState 目前網址)
  push(): void
  // 吃掉哨兵(history.back)
  back(): void
  // 哨兵被吃掉後回到根層:底下那筆網址可能還停在舊畫面(例如 deep link),校正回根層網址
  onRootReturn(): void
}

export type ViewBackController = {
  // 設定目前畫面的返回動作;undefined 代表已回到根層
  set(back?: () => void): void
  // 瀏覽器 popstate 時呼叫
  handlePop(): void
}

export function createViewBackController(history: SentinelHistory): ViewBackController {
  let action: (() => void) | undefined
  let sentinel = false
  let skipNextPop = false

  return {
    set(back?: () => void) {
      action = back
      if (back && !sentinel) {
        history.push()
        sentinel = true
      } else if (!back && sentinel) {
        // 經 UI 按鈕回到根層:把哨兵吃掉,下一次瀏覽器返回才會真的離開地圖。
        sentinel = false
        skipNextPop = true
        history.back()
      }
    },
    handlePop() {
      if (skipNextPop) {
        skipNextPop = false
        history.onRootReturn()
        return
      }
      if (!sentinel) return
      sentinel = false
      const back = action
      action = undefined
      back?.()
    },
  }
}
