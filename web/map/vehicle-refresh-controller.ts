export const VEHICLE_REFRESH_INTERVAL_MS = 20_000

type TimerHandle = unknown

export type VehicleRefreshSession<Route> = {
  cityCode: string
  route: Route
}

type VehicleRefreshOptions<Route, Response> = {
  load: (cityCode: string, route: Route, signal: AbortSignal) => Promise<Response>
  isActive: (session: VehicleRefreshSession<Route>) => boolean
  onResponse: (response: Response) => void
  onError: (error: unknown) => void
  onStop: () => void
  intervalMs?: number
  setInterval?: (callback: () => void, intervalMs: number) => TimerHandle
  clearInterval?: (handle: TimerHandle) => void
  createAbortController?: () => AbortController
}

export type VehicleRefreshController<Route> = {
  start: (session: VehicleRefreshSession<Route>) => void
  refresh: () => Promise<void>
  stop: () => void
}

/**
 * Owns the timer, request cancellation and stale-session checks for live vehicle
 * positions. Rendering remains outside this controller so Leaflet and drawer
 * side effects stay in the map entry layer.
 */
export function createVehicleRefreshController<Route, Response>(
  options: VehicleRefreshOptions<Route, Response>,
): VehicleRefreshController<Route> {
  const intervalMs = options.intervalMs ?? VEHICLE_REFRESH_INTERVAL_MS
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new Error('Vehicle refresh interval must be a positive finite number')
  }

  const setIntervalFn = options.setInterval
    ?? ((callback, delayMs) => globalThis.setInterval(callback, delayMs))
  const clearIntervalFn = options.clearInterval
    ?? ((handle) => globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>))
  const createAbortController = options.createAbortController ?? (() => new AbortController())

  let timer: TimerHandle | undefined
  let epoch = 0
  let session: VehicleRefreshSession<Route> | undefined
  let activeAbortController: AbortController | undefined

  function clearScheduled(): void {
    if (timer === undefined) return
    clearIntervalFn(timer)
    timer = undefined
  }

  async function refresh(): Promise<void> {
    const currentSession = session
    const currentEpoch = epoch
    if (!currentSession || !options.isActive(currentSession)) return

    activeAbortController?.abort()
    const abortController = createAbortController()
    activeAbortController = abortController

    try {
      const response = await options.load(
        currentSession.cityCode,
        currentSession.route,
        abortController.signal,
      )
      if (
        abortController.signal.aborted
        || epoch !== currentEpoch
        || session !== currentSession
        || !options.isActive(currentSession)
      ) return
      options.onResponse(response)
    } catch (error) {
      if (
        !abortController.signal.aborted
        && epoch === currentEpoch
        && session === currentSession
        && options.isActive(currentSession)
      ) options.onError(error)
    } finally {
      if (activeAbortController === abortController) activeAbortController = undefined
    }
  }

  function stop(): void {
    epoch += 1
    session = undefined
    activeAbortController?.abort()
    activeAbortController = undefined
    clearScheduled()
    options.onStop()
  }

  return {
    start(nextSession) {
      stop()
      session = nextSession
      void refresh()
      timer = setIntervalFn(() => void refresh(), intervalMs)
    },
    refresh,
    stop,
  }
}
