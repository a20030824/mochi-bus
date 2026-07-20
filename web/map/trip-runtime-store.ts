import type { TripSelectionKind } from '../../src/domain/map/trip-selection'
import type { TDXWarning } from '../../src/domain/tdx-warning'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import {
  clearTripPendingSelection,
  clearTripPendingSelections,
  completeTripResults,
  hasTripResultsState,
  idleTripState,
  resumeTripEndpoint,
  selectDirectTripResult,
  selectTransferTripResult,
  selectTripEndpoint,
  setTripPendingSelection,
  setTripWarning,
  startTripSelection,
  tripEndpoint,
  tripPendingSelection,
  type TripCoordinate,
  type TripEndpoint,
  type TripPendingSelection,
  type TripResultsState,
  type TripState,
} from './trip-state'

export type TripRuntimeStage = 'idle' | TripSelectionKind

export type TripRuntimeStore = {
  readonly state: TripState
  readonly stage: TripRuntimeStage
  readonly from: NearbyPlace | undefined
  readonly to: NearbyPlace | undefined
  readonly fromCoordinate: TripCoordinate | undefined
  readonly toCoordinate: TripCoordinate | undefined
  readonly directRoutes: DirectRoute[]
  readonly transferPlans: TransferPlan[]
  readonly selectedDirectIndex: number
  readonly selectedTransferIndex: number
  readonly warning: TDXWarning | undefined
  start(): void
  reset(): void
  focus(kind: TripSelectionKind): void
  selectEndpoint(kind: TripSelectionKind, place: NearbyPlace, coordinate: TripCoordinate): boolean
  begin(from: TripEndpoint, to: TripEndpoint): void
  restore(state: TripResultsState): void
  pending(kind: TripSelectionKind): TripPendingSelection | undefined
  setPending(selection: TripPendingSelection): void
  updatePendingCandidate(kind: TripSelectionKind, selected: NearbyPlace): void
  clearPending(kind?: TripSelectionKind): void
  setWarning(warning: TDXWarning | undefined): void
  completeDirect(routes: DirectRoute[]): void
  completeTransfer(plans: TransferPlan[]): void
  completeEmpty(): void
  selectDirect(index: number): void
  selectTransfer(index: number): void
  hasResults(): boolean
  results(): TripResultsState | undefined
}

export function createTripRuntimeStore(initialState: TripState = idleTripState()): TripRuntimeStore {
  let current = initialState

  const endpoint = (kind: TripSelectionKind) => tripEndpoint(current, kind)

  function focus(kind: TripSelectionKind): void {
    if (current.phase === 'idle') {
      current = { phase: 'selecting', next: kind, pending: {} }
      return
    }
    current = {
      phase: 'selecting',
      next: kind,
      from: current.from,
      to: current.to,
      pending: current.pending,
    }
  }

  function selectEndpoint(
    kind: TripSelectionKind,
    place: NearbyPlace,
    coordinate: TripCoordinate,
  ): boolean {
    const pending = tripPendingSelection(current, kind)
    if (pending) {
      current = setTripPendingSelection(current, { ...pending, selected: place })
    }
    current = selectTripEndpoint(current, kind, { place, coordinate })
    return current.phase === 'loading'
  }

  function begin(from: TripEndpoint, to: TripEndpoint): void {
    current = {
      phase: 'loading',
      from,
      to,
      pending: current.phase === 'idle' ? {} : current.pending,
    }
  }

  function complete(
    directRoutes: DirectRoute[],
    transferPlans: TransferPlan[],
  ): void {
    if (current.phase !== 'loading' && current.phase !== 'results') {
      throw new Error('Trip results require both selected endpoints')
    }
    current = completeTripResults(current, {
      directRoutes,
      transferPlans,
      selectedDirectIndex: 0,
      selectedTransferIndex: 0,
      warning: current.warning,
    })
  }

  const store: TripRuntimeStore = {
    get state() {
      return current
    },
    get stage() {
      return current.phase === 'selecting' ? current.next : 'idle'
    },
    get from() {
      return endpoint('from')?.place
    },
    get to() {
      return endpoint('to')?.place
    },
    get fromCoordinate() {
      return endpoint('from')?.coordinate
    },
    get toCoordinate() {
      return endpoint('to')?.coordinate
    },
    get directRoutes() {
      return current.phase === 'results' ? current.directRoutes : []
    },
    get transferPlans() {
      return current.phase === 'results' ? current.transferPlans : []
    },
    get selectedDirectIndex() {
      return current.phase === 'results' ? current.selectedDirectIndex : 0
    },
    get selectedTransferIndex() {
      return current.phase === 'results' ? current.selectedTransferIndex : 0
    },
    get warning() {
      return current.phase === 'loading' || current.phase === 'results'
        ? current.warning
        : undefined
    },
    start() {
      current = startTripSelection()
    },
    reset() {
      current = idleTripState()
    },
    focus,
    selectEndpoint,
    begin,
    restore(state) {
      current = state
    },
    pending(kind) {
      return tripPendingSelection(current, kind)
    },
    setPending(selection) {
      current = setTripPendingSelection(current, selection)
    },
    updatePendingCandidate(kind, selected) {
      const pending = tripPendingSelection(current, kind)
      if (pending) current = setTripPendingSelection(current, { ...pending, selected })
    },
    clearPending(kind) {
      current = kind
        ? clearTripPendingSelection(current, kind)
        : clearTripPendingSelections(current)
    },
    setWarning(warning) {
      current = setTripWarning(current, warning)
    },
    completeDirect(routes) {
      complete(routes, [])
    },
    completeTransfer(plans) {
      complete([], plans)
    },
    completeEmpty() {
      complete([], [])
    },
    selectDirect(index) {
      if (current.phase === 'results') current = selectDirectTripResult(current, index)
    },
    selectTransfer(index) {
      if (current.phase === 'results') current = selectTransferTripResult(current, index)
    },
    hasResults() {
      return hasTripResultsState(current)
    },
    results() {
      return current.phase === 'results' ? current : undefined
    },
  }

  return store
}
