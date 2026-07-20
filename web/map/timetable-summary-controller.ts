export type TimetableSummarySession<Variant, Target> = Readonly<{
  cityCode: string
  variant: Variant
  target: Target
}>

type TimetableSummaryOptions<Variant, Response, Target> = {
  load: (cityCode: string, variant: Variant, signal: AbortSignal) => Promise<Response>
  isTargetActive: (target: Target) => boolean
  isAvailable: (response: Response) => boolean
  onAvailable: (session: TimetableSummarySession<Variant, Target>, response: Response) => void
  onUnavailable: (session: TimetableSummarySession<Variant, Target>) => void
  onError: (session: TimetableSummarySession<Variant, Target>, error: unknown) => void
  createAbortController?: () => AbortController
}

export type TimetableSummaryController<Variant, Target> = {
  start: (session: TimetableSummarySession<Variant, Target>) => void
  stop: () => void
}

/**
 * Keeps only the latest route timetable summary request alive. The target is
 * opaque to this controller; DOM presence and rendering stay in the map entry.
 */
export function createTimetableSummaryController<Variant, Response, Target>(
  options: TimetableSummaryOptions<Variant, Response, Target>,
): TimetableSummaryController<Variant, Target> {
  const createAbortController = options.createAbortController ?? (() => new AbortController())

  let requestId = 0
  let activeSession: TimetableSummarySession<Variant, Target> | undefined
  let activeAbortController: AbortController | undefined

  function isCurrent(
    id: number,
    session: TimetableSummarySession<Variant, Target>,
    abortController: AbortController,
  ): boolean {
    return !abortController.signal.aborted
      && id === requestId
      && activeSession === session
      && options.isTargetActive(session.target)
  }

  async function run(
    id: number,
    session: TimetableSummarySession<Variant, Target>,
    abortController: AbortController,
  ): Promise<void> {
    try {
      const response = await options.load(session.cityCode, session.variant, abortController.signal)
      if (!isCurrent(id, session, abortController)) return
      if (options.isAvailable(response)) options.onAvailable(session, response)
      else options.onUnavailable(session)
    } catch (error) {
      if (isCurrent(id, session, abortController)) options.onError(session, error)
    } finally {
      if (activeAbortController === abortController) activeAbortController = undefined
    }
  }

  function stop(): void {
    requestId += 1
    activeSession = undefined
    activeAbortController?.abort()
    activeAbortController = undefined
  }

  return {
    start(session) {
      stop()
      activeSession = session
      const id = requestId
      const abortController = createAbortController()
      activeAbortController = abortController
      void run(id, session, abortController)
    },
    stop,
  }
}
