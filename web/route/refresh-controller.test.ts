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

  it('uses the delay selected by the settled refresh result', async () => {
    const clock = createClock()
    const refresh = vi.fn()
      .mockResolvedValueOnce({ nextDelayMs: 120_000 })
      .mockResolvedValue(undefined)
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    await clock.advance(119_999)
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

  it('keeps the remaining adaptive delay after a hidden-page pause', async () => {
    const clock = createClock()
    const refresh = vi.fn()
      .mockResolvedValueOnce({ nextDelayMs: 300_000 })
      .mockResolvedValue(undefined)
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
    await clock.advance(60_000)
    visible = false
    await controller.visibilityChanged()
    await clock.advance(60_000)
    visible = true
    await controller.visibilityChanged()

    await clock.advance(179_999)
    expect(refresh).toHaveBeenCalledTimes(1)
    await clock.advance(1)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('aborts an active request while hidden and refreshes when visible again', async () => {
    const clock = createClock()
    let visible = true
    let firstSignal: AbortSignal | undefined
    const refresh = vi.fn((signal: AbortSignal) => {
      if (!firstSignal) {
        firstSignal = signal
        return new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
      }
      return Promise.resolve()
    })
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => visible,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    const first = controller.start()
    await Promise.resolve()
    visible = false
    await controller.visibilityChanged()
    await first
    expect(firstSignal?.aborted).toBe(true)

    visible = true
    await controller.visibilityChanged()
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

  it('stops scheduling after a terminal refresh result', async () => {
    const clock = createClock()
    const refresh = vi.fn(async () => 'stop' as const)
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    await controller.start()
    await clock.advance(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('stops future refreshes and aborts an active request', async () => {
    const clock = createClock()
    let activeSignal: AbortSignal | undefined
    const refresh = vi.fn((signal: AbortSignal) => new Promise<void>((resolve) => {
      activeSignal = signal
      signal.addEventListener('abort', () => resolve(), { once: true })
    }))
    const controller = createVisibleRefreshController({
      refresh,
      intervalMs: 30_000,
      isVisible: () => true,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    })

    const first = controller.start()
    await Promise.resolve()
    controller.stop()
    await first
    expect(activeSignal?.aborted).toBe(true)

    await clock.advance(60_000)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
