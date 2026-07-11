import { describe, expect, it } from 'vitest'
import { createNavRequestCoordinator } from './nav-request'

describe('createNavRequestCoordinator', () => {
  it('後發的 begin() 讓先發的 requestId 變成 stale', () => {
    const nav = createNavRequestCoordinator()
    const first = nav.begin()
    const second = nav.begin()
    expect(nav.isStale(first.requestId)).toBe(true)
    expect(nav.isStale(second.requestId)).toBe(false)
  })

  it('模擬 A 慢、B 快:A 的回應落地時已經是 stale,B 仍是目前狀態', async () => {
    const nav = createNavRequestCoordinator()
    const order: string[] = []

    async function load(label: string, delayMs: number, requestId: number) {
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (nav.isStale(requestId)) return
      order.push(label)
    }

    const a = nav.begin()
    const loadA = load('A', 20, a.requestId)
    const b = nav.begin()
    const loadB = load('B', 5, b.requestId)
    await Promise.all([loadA, loadB])

    expect(order).toEqual(['B'])
  })

  it('begin() 會 abort 前一輪還沒完成的 signal,不覆蓋畫面也省頻寬', () => {
    const nav = createNavRequestCoordinator()
    const first = nav.begin()
    expect(first.signal.aborted).toBe(false)
    nav.begin()
    expect(first.signal.aborted).toBe(true)
  })

  it('只有一輪 in-flight 時,自己的 signal 不會被自己 abort', () => {
    const nav = createNavRequestCoordinator()
    const only = nav.begin()
    expect(only.signal.aborted).toBe(false)
    expect(nav.isStale(only.requestId)).toBe(false)
  })
})
