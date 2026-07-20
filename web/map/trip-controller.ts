import { getTripSelectionConflict, type TripSelectionKind } from '../../src/domain/map/trip-selection'
import type { NearbyPlace, SearchPlace } from './map-api-client'
import type { TripPlanLoader, TripPlanLoadPhase } from './trip-plan-loader'
import type { TripRuntimeStore } from './trip-runtime-store'
import type { TripCoordinate, TripEndpoint, TripResultsState } from './trip-state'

const DEFAULT_NEARBY_CANDIDATE_LIMIT = 5

export type TripResultsPresentation = {
  fitCamera: boolean
}

export type TripPlanContext = {
  from: NearbyPlace
  to: NearbyPlace
}

type TripControllerOptions = {
  store: TripRuntimeStore
  planLoader: TripPlanLoader
  currentCityCode: () => string | undefined
  nearbyRadius: () => number
  loadNearby: (
    cityCode: string,
    latitude: number,
    longitude: number,
    radius: number,
    signal?: AbortSignal,
  ) => Promise<NearbyPlace[]>
  beginRequest: () => { requestId: number; signal: AbortSignal }
  cancelRequest: () => void
  isStaleRequest: (requestId: number) => boolean
  candidateLimit?: number
  onSelectionStep: (kind: TripSelectionKind) => void
  onCandidates: (kind: TripSelectionKind) => void
  onEndpointReady: () => void
  onStatus: (message: string, error?: boolean) => void
  onPlanStart: (context: TripPlanContext) => void
  onPlanPhase: (phase: TripPlanLoadPhase, context: TripPlanContext) => void
  onResults: (presentation: TripResultsPresentation) => Promise<boolean>
  onPlanError: (error: unknown, context: TripPlanContext) => void
}

export type TripController = {
  start(): void
  reset(): void
  clearPending(kind?: TripSelectionKind): void
  focus(kind: TripSelectionKind): void
  resume(kind: TripSelectionKind): void
  showCandidates(kind: TripSelectionKind): void
  selectCoordinate(latitude: number, longitude: number): Promise<void>
  selectCandidate(kind: TripSelectionKind, candidate: NearbyPlace): Promise<boolean>
  selectPlace(kind: TripSelectionKind, place: SearchPlace): Promise<boolean>
  loadPlan(): Promise<void>
  showResults(presentation: TripResultsPresentation): Promise<boolean>
  selectDirect(index: number): Promise<boolean>
  selectTransfer(index: number): Promise<boolean>
  begin(from: TripEndpoint, to: TripEndpoint): void
  restore(state: TripResultsState): void
  hasResults(): boolean
}

export function createTripController(options: TripControllerOptions): TripController {
  const candidateLimit = options.candidateLimit ?? DEFAULT_NEARBY_CANDIDATE_LIMIT
  if (!Number.isInteger(candidateLimit) || candidateLimit <= 0) {
    throw new Error('Trip nearby candidate limit must be a positive integer')
  }

  let selectingCoordinate = false
  let selectionGeneration = 0

  function invalidateSelectionRequest(): void {
    selectionGeneration += 1
    selectingCoordinate = false
    options.cancelRequest()
  }

  function currentPlanContext(): TripPlanContext | undefined {
    const from = options.store.from
    const to = options.store.to
    return from && to ? { from, to } : undefined
  }

  function focus(kind: TripSelectionKind): void {
    invalidateSelectionRequest()
    options.store.focus(kind)
    options.onSelectionStep(kind)
  }

  function resume(kind: TripSelectionKind): void {
    invalidateSelectionRequest()
    options.store.reselect(kind)
    options.onSelectionStep(kind)
  }

  function showCandidates(kind: TripSelectionKind): void {
    if (!options.store.pending(kind)) {
      focus(kind)
      return
    }
    options.onCandidates(kind)
  }

  async function applySelection(
    kind: TripSelectionKind,
    candidate: NearbyPlace,
    coordinate: TripCoordinate,
  ): Promise<boolean> {
    const conflict = getTripSelectionConflict(kind, candidate, options.store.from, options.store.to)
    if (conflict) {
      options.onStatus(conflict, true)
      return false
    }

    const ready = options.store.selectEndpoint(kind, candidate, coordinate)
    if (!ready) {
      options.onSelectionStep(kind === 'from' ? 'to' : 'from')
      return true
    }

    options.onEndpointReady()
    await loadPlan()
    return true
  }

  async function selectCandidate(kind: TripSelectionKind, candidate: NearbyPlace): Promise<boolean> {
    invalidateSelectionRequest()
    const pending = options.store.pending(kind)
    if (!pending) return false
    return applySelection(kind, candidate, pending.coordinate)
  }

  async function selectPlace(kind: TripSelectionKind, place: SearchPlace): Promise<boolean> {
    invalidateSelectionRequest()
    options.store.clearPending(kind)
    const candidate: NearbyPlace = { ...place, distanceMeters: 0 }
    return applySelection(kind, candidate, [place.latitude, place.longitude])
  }

  async function selectCoordinate(latitude: number, longitude: number): Promise<void> {
    const cityCode = options.currentCityCode()
    const kind = options.store.stage
    if (!cityCode || kind === 'idle' || selectingCoordinate) return

    const { requestId, signal } = options.beginRequest()
    const generation = ++selectionGeneration
    selectingCoordinate = true
    options.store.clearPending(kind)
    options.onStatus('正在尋找附近站牌…')

    try {
      const places = await options.loadNearby(
        cityCode,
        latitude,
        longitude,
        options.nearbyRadius(),
        signal,
      )
      if (signal.aborted
        || options.isStaleRequest(requestId)
        || options.currentCityCode() !== cityCode
        || options.store.stage !== kind
        || selectionGeneration !== generation) return

      const candidates = places.slice(0, candidateLimit)
      const nearest = candidates[0]
      if (!nearest) throw new Error('這附近沒有站牌')

      options.store.setPending({
        kind,
        coordinate: [latitude, longitude],
        candidates,
        selected: nearest,
      })
      await applySelection(kind, nearest, [latitude, longitude])
    } catch (error) {
      if (signal.aborted || options.isStaleRequest(requestId)) return
      options.onStatus(error instanceof Error ? error.message : '附近站牌讀取失敗', true)
    } finally {
      if (selectionGeneration === generation) selectingCoordinate = false
    }
  }

  async function showResults(presentation: TripResultsPresentation): Promise<boolean> {
    if (options.store.state.phase !== 'results') return false
    return options.onResults(presentation)
  }

  async function loadPlan(): Promise<void> {
    const cityCode = options.currentCityCode()
    const context = currentPlanContext()
    if (!cityCode || !context) return

    options.onPlanStart(context)
    const { requestId, signal } = options.beginRequest()
    options.store.setWarning(undefined)

    try {
      const result = await options.planLoader.load({
        cityCode,
        fromPlaceId: context.from.placeId,
        toPlaceId: context.to.placeId,
        signal,
        onPhase: (phase) => options.onPlanPhase(phase, context),
      })
      if (signal.aborted
        || options.isStaleRequest(requestId)
        || options.currentCityCode() !== cityCode
        || !result) return

      options.store.setWarning(result.warning)
      if (result.kind === 'direct') options.store.completeDirect(result.routes)
      else if (result.kind === 'transfer') options.store.completeTransfer(result.plans)
      else options.store.completeEmpty()

      await showResults({ fitCamera: true })
    } catch (error) {
      if (signal.aborted || options.isStaleRequest(requestId)) return
      options.onPlanError(error, context)
    }
  }

  return {
    start() {
      invalidateSelectionRequest()
      options.store.start()
      options.onSelectionStep('from')
    },
    reset() {
      invalidateSelectionRequest()
      options.store.reset()
    },
    clearPending(kind) {
      options.store.clearPending(kind)
    },
    focus,
    resume,
    showCandidates,
    selectCoordinate,
    selectCandidate,
    selectPlace,
    loadPlan,
    showResults,
    async selectDirect(index) {
      options.store.selectDirect(index)
      return showResults({ fitCamera: true })
    },
    async selectTransfer(index) {
      options.store.selectTransfer(index)
      return showResults({ fitCamera: true })
    },
    begin(from, to) {
      invalidateSelectionRequest()
      options.store.begin(from, to)
      options.onEndpointReady()
    },
    restore(state) {
      invalidateSelectionRequest()
      options.store.restore(state)
    },
    hasResults() {
      return options.store.hasResults()
    },
  }
}
