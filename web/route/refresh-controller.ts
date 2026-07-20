export const ROUTE_REFRESH_INTERVAL_MS = 30_000

type TimerHandle = unknown

export type VisibleRefreshResult = 'stop' | void

type VisibleRefreshOptions = {
  refresh: (signal: AbortSignal) => Promise<VisibleRefreshResult>
  intervalMs?: number
  isVisible?: () => boolean
  now?: () => number
  setTimer?: (callback: () => void, delayMs: number) => TimerHandle
  clearTimer?: (handle: TimerHandle) => void
}

export type VisibleRefreshController = {
  start: () => Promise<void>
  visibilityChanged: () => Promise<void>
  stop: () => void
}

/**
 * Refresh immediately while visible, then wait one full interval after each
 * settled request. Hidden pages keep no timer and abort any active request;
 * terminal refresh results stop the controller instead of retrying forever.
 */
export function createVisibleRefreshController(options: VisibleRefreshOptions): VisibleRefreshController {
  const intervalMs = options.intervalMs ?? ROUTE_REFRESH_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Route refresh interval must be a positive finite number')
  }

  const isVisible = options.isVisible ?? (() => document.visibilityState === 'visible')
  const now = options.now ?? (() => Date.now())
  const setTimer = options.setTimer ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs))
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>))

  let timer: TimerHandle | undefined
  let running = false
  let stopped = false
  let lastSettledAt: number | undefined
  let activeAbortController: AbortController | undefined

  function clearScheduled(): void {
    if (timer === undefined) return
    clearTimer(timer)
    timer = undefined
  }

  function abortActive(): void {
    activeAbortController?.abort()
  }

  function schedule(delayMs: number): void {
    if (stopped || running || !isVisible()) return
    clearScheduled()
    timer = setTimer(() => {
      timer = undefined
      void runRefresh().catch(() => {})
    }, Math.max(0, delayMs))
  }

  async function runRefresh(): Promise<void> {
    if (stopped || running || !isVisible()) return
    clearScheduled()
    running = true
    const abortController = new AbortController()
    activeAbortController = abortController
    let result: VisibleRefreshResult = undefined
    let failed = false
    let failure: unknown

    try {
      result = await options.refresh(abortController.signal)
    } catch (error) {
      failed = true
      failure = error
    } finally {
      if (activeAbortController === abortController) activeAbortController = undefined
      running = false
    }

    if (abortController.signal.aborted) {
      if (!stopped && isVisible()) schedule(0)
      return
    }

    lastSettledAt = now()
    if (result === 'stop') {
      stopped = true
      clearScheduled()
      return
    }

    schedule(intervalMs)
    if (failed) throw failure
  }

  async function visibilityChanged(): Promise<void> {
    if (stopped) return
    clearScheduled()
    if (!isVisible()) {
      abortActive()
      return
    }
    if (running) return

    if (lastSettledAt === undefined) {
      await runRefresh()
      return
    }

    const elapsed = Math.max(0, now() - lastSettledAt)
    if (elapsed >= intervalMs) await runRefresh()
    else schedule(intervalMs - elapsed)
  }

  return {
    start: runRefresh,
    visibilityChanged,
    stop() {
      stopped = true
      clearScheduled()
      abortActive()
    },
  }
}
