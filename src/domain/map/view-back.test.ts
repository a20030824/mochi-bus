import { describe, expect, it } from 'vitest'
import { createViewBackController, type SentinelHistory } from './view-back'

function setup() {
  const calls: string[] = []
  const history: SentinelHistory = {
    push: () => calls.push('push'),
    back: () => calls.push('back'),
    onRootReturn: () => calls.push('rootReturn'),
  }
  return { calls, controller: createViewBackController(history) }
}

describe('createViewBackController', () => {
  it('離開根層時只推一次哨兵,畫面再往深走不重複推', () => {
    const { calls, controller } = setup()
    controller.set(() => {})
    controller.set(() => {})
    controller.set(() => {})
    expect(calls).toEqual(['push'])
  })

  it('popstate 執行目前畫面的返回動作;返回動作再設定退路時補推哨兵', () => {
    const { calls, controller } = setup()
    const visited: string[] = []
    const backToRegion = () => {
      visited.push('region')
      controller.set(() => visited.push('taiwan'))
    }
    controller.set(backToRegion)
    controller.handlePop()
    expect(visited).toEqual(['region'])
    // 返回動作內重新 set 了退路,哨兵要再補一筆
    expect(calls).toEqual(['push', 'push'])
    controller.handlePop()
    expect(visited).toEqual(['region', 'taiwan'])
  })

  it('經 UI 按鈕回到根層:吃掉哨兵,產生的 popstate 只做網址校正', () => {
    const { calls, controller } = setup()
    controller.set(() => {
      throw new Error('回根層後不應再執行返回動作')
    })
    controller.set(undefined)
    expect(calls).toEqual(['push', 'back'])
    // history.back() 觸發的 popstate
    controller.handlePop()
    expect(calls).toEqual(['push', 'back', 'rootReturn'])
    // 之後的返回鍵已無哨兵,交還給瀏覽器(不做事)
    controller.handlePop()
    expect(calls).toEqual(['push', 'back', 'rootReturn'])
  })

  it('根層直接按返回鍵:沒有哨兵,不攔截', () => {
    const { calls, controller } = setup()
    controller.handlePop()
    expect(calls).toEqual([])
  })

  it('在根層重複 set(undefined) 不會多吃 history', () => {
    const { calls, controller } = setup()
    controller.set(undefined)
    controller.set(undefined)
    expect(calls).toEqual([])
  })
})
