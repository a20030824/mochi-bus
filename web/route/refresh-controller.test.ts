import { describe, expect, it, vi } from 'vitest'
import { createVisibleRefreshController } from './refresh-controller'

function createClock() {
  let current = 0
  let nextId = 1
  const timers = new Map<number, { due: number; callback: () => void }>()

  return {
    now: () => current,
    setTimer(callback: () => void, delayMs: number) {
      const id = nextId++
      timers.set(id, { due: current + delayMs, callback })
      return id
    },
    clearTimer(handle: unknown) {
      timers.delete(handle as number)
    },
    async advance(delayMs: number) {
      current += delayMs
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.due <= current)
        .sort((left, right) => left[1].due - right[1].due)
      for (const [id, timer] of due) {
        timers.delete(id)
        timer.callback()
      }
      await Promise.resolve()
      await Promise.resolve()
    },
  }
}

describe('createVisibleRefreshController', () => {
  it('refreshes immediately and waits a full interval after settlement', async () => {
    const clock = createClock()
    const refresh = vi.fn(async () => {})
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    expect(refresh).toHaveBeenCalledTimes(1)

    await clock.advance(29_999)
    expect(refresh).toHaveBeenCalledTimes(1)

    await clock.advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('keeps no timer while hidden and refreshes on a stale return', async () => {
    const clock = createClock()
    const refresh = vi.fn(async () => {})
    let visible = true
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => visible,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    visible = false
    await controller.visibilityChanged()
    await clock.advance(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    visible = true
    await controller.visibilityChanged()
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('waits only the remaining interval after a fresh visible return', async () => {
    const clock = createClock()
    const refresh = vi.fn(async () => {})
    let visible = true
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => visible,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    await clock.advance(10_000)
    visible = false
    await controller.visibilityChanged()
    await clock.advance(10_000)
    visible = true
    await controller.visibilityChanged()

    await clock.advance(9_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await clock.advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('never overlaps refresh requests', async () => {
    const clock = createClock()
    let release: (() => void) | undefined
    const refresh = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    const first = controller.start()
    await controller.visibilityChanged()
    await clock.advance(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)

    release?.()
    await first
    await clock.advance(30_000)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('stops future refreshes', async () => {
    const clock = createClock()
    const refresh = vi.fn(async () => {})
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    controller.stop()
    await clock.advance(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
