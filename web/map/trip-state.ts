import type { TripSelectionKind } from '../../src/domain/map/trip-selection'
import type { TDXWarning } from '../../src/domain/tdx-warning'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'

export type TripCoordinate = [number, number]

export type TripEndpoint = {
  place: NearbyPlace
  coordinate?: TripCoordinate
}

export type TripPendingSelection = {
  kind: TripSelectionKind
  coordinate: TripCoordinate
  candidates: NearbyPlace[]
  selected: NearbyPlace
}

export type TripPendingSelections = Partial<Record<TripSelectionKind, TripPendingSelection>>

export type TripIdleState = {
  phase: 'idle'
}

export type TripSelectingState = {
  phase: 'selecting'
  next: TripSelectionKind
  from?: TripEndpoint
  to?: TripEndpoint
  pending: TripPendingSelections
}

export type TripLoadingState = {
  phase: 'loading'
  from: TripEndpoint
  to: TripEndpoint
  pending: TripPendingSelections
}

type TripResultsBase = {
  phase: 'results'
  from: TripEndpoint
  to: TripEndpoint
  warning?: TDXWarning
  pending: TripPendingSelections
}

export type TripDirectResultsState = TripResultsBase & {
  resultKind: 'direct'
  directRoutes: DirectRoute[]
  transferPlans: []
  selectedDirectIndex: number
  selectedTransferIndex: 0
}

export type TripTransferResultsState = TripResultsBase & {
  resultKind: 'transfer'
  directRoutes: []
  transferPlans: TransferPlan[]
  selectedDirectIndex: 0
  selectedTransferIndex: number
}

export type TripEmptyResultsState = TripResultsBase & {
  resultKind: 'empty'
  directRoutes: []
  transferPlans: []
  selectedDirectIndex: 0
  selectedTransferIndex: 0
}

export type TripResultsState =
  | TripDirectResultsState
  | TripTransferResultsState
  | TripEmptyResultsState

export type TripState = TripIdleState | TripSelectingState | TripLoadingState | TripResultsState

export type TripResultCollectionsInput = {
  directRoutes: DirectRoute[]
  transferPlans: TransferPlan[]
  selectedDirectIndex?: number
  selectedTransferIndex?: number
  warning?: TDXWarning
}

export type TripResultsInput = TripResultCollectionsInput & {
  from: TripEndpoint
  to: TripEndpoint
  pending?: TripPendingSelections
}

export function idleTripState(): TripIdleState {
  return { phase: 'idle' }
}

export function startTripSelection(): TripSelectingState {
  return {
    phase: 'selecting',
    next: 'from',
    pending: {},
  }
}

export function createTripResultsState(input: TripResultsInput): TripResultsState {
  const base = {
    phase: 'results' as const,
    from: input.from,
    to: input.to,
    warning: input.warning,
    pending: input.pending ?? {},
  }

  // The live workflow queries transfers only when no direct route exists. When a
  // legacy or malformed snapshot contains both, preserve the existing direct-first UI rule.
  if (input.directRoutes.length) {
    return {
      ...base,
      resultKind: 'direct',
      directRoutes: input.directRoutes,
      transferPlans: [],
      selectedDirectIndex: normalizeTripResultIndex(input.selectedDirectIndex, input.directRoutes.length),
      selectedTransferIndex: 0,
    }
  }
  if (input.transferPlans.length) {
    return {
      ...base,
      resultKind: 'transfer',
      directRoutes: [],
      transferPlans: input.transferPlans,
      selectedDirectIndex: 0,
      selectedTransferIndex: normalizeTripResultIndex(input.selectedTransferIndex, input.transferPlans.length),
    }
  }
  return {
    ...base,
    resultKind: 'empty',
    directRoutes: [],
    transferPlans: [],
    selectedDirectIndex: 0,
    selectedTransferIndex: 0,
  }
}

export function tripEndpoint(state: TripState, kind: TripSelectionKind): TripEndpoint | undefined {
  if (state.phase === 'idle') return undefined
  return kind === 'from' ? state.from : state.to
}

export function tripPendingSelection(
  state: TripState,
  kind: TripSelectionKind,
): TripPendingSelection | undefined {
  if (state.phase === 'idle') return undefined
  return state.pending[kind]
}

export function selectTripEndpoint(
  state: TripState,
  kind: TripSelectionKind,
  endpoint: TripEndpoint,
): TripSelectingState | TripLoadingState {
  const current = state.phase === 'idle'
    ? startTripSelection()
    : state
  const from = kind === 'from' ? endpoint : current.from
  const to = kind === 'to' ? endpoint : current.to
  const pending = current.pending

  if (from && to) {
    return {
      phase: 'loading',
      from,
      to,
      pending,
    }
  }

  return {
    phase: 'selecting',
    next: kind === 'from' ? 'to' : 'from',
    from,
    to,
    pending,
  }
}

export function resumeTripEndpoint(
  state: TripState,
  kind: TripSelectionKind,
): TripSelectingState {
  if (state.phase === 'idle') {
    return {
      phase: 'selecting',
      next: kind,
      pending: {},
    }
  }

  const pending = withoutPending(state.pending, kind)
  return {
    phase: 'selecting',
    next: kind,
    from: kind === 'from' ? undefined : state.from,
    to: kind === 'to' ? undefined : state.to,
    pending,
  }
}

export function completeTripResults(
  state: TripLoadingState | TripResultsState,
  input: TripResultCollectionsInput,
): TripResultsState {
  return createTripResultsState({
    from: state.from,
    to: state.to,
    directRoutes: input.directRoutes,
    transferPlans: input.transferPlans,
    selectedDirectIndex: input.selectedDirectIndex,
    selectedTransferIndex: input.selectedTransferIndex,
    warning: input.warning,
    pending: state.pending,
  })
}

export function setTripPendingSelection(
  state: TripState,
  selection: TripPendingSelection,
): TripSelectingState | TripLoadingState | TripResultsState {
  const current = state.phase === 'idle'
    ? {
        phase: 'selecting' as const,
        next: selection.kind,
        pending: {},
      }
    : state
  return {
    ...current,
    pending: {
      ...current.pending,
      [selection.kind]: selection,
    },
  }
}

export function clearTripPendingSelection(
  state: TripState,
  kind: TripSelectionKind,
): TripState {
  if (state.phase === 'idle') return state
  return {
    ...state,
    pending: withoutPending(state.pending, kind),
  }
}

export function clearTripPendingSelections(state: TripState): TripState {
  if (state.phase === 'idle') return state
  return {
    ...state,
    pending: {},
  }
}

export function selectDirectTripResult(state: TripResultsState, index: number): TripResultsState {
  if (state.resultKind !== 'direct') return state
  return {
    ...state,
    selectedDirectIndex: normalizeTripResultIndex(index, state.directRoutes.length),
  }
}

export function selectTransferTripResult(state: TripResultsState, index: number): TripResultsState {
  if (state.resultKind !== 'transfer') return state
  return {
    ...state,
    selectedTransferIndex: normalizeTripResultIndex(index, state.transferPlans.length),
  }
}

export function hasTripResultsState(state: TripState): state is TripDirectResultsState | TripTransferResultsState {
  return state.phase === 'results' && state.resultKind !== 'empty'
}

export function normalizeTripResultIndex(index: number | undefined, length: number): number {
  if (!length || !Number.isInteger(index)) return 0
  return Math.min(Math.max(index as number, 0), length - 1)
}

function withoutPending(
  pending: TripPendingSelections,
  kind: TripSelectionKind,
): TripPendingSelections {
  const next = { ...pending }
  delete next[kind]
  return next
}
