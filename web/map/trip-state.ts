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

export type TripResultsState = {
  phase: 'results'
  from: TripEndpoint
  to: TripEndpoint
  directRoutes: DirectRoute[]
  transferPlans: TransferPlan[]
  selectedDirectIndex: number
  selectedTransferIndex: number
  warning?: TDXWarning
  pending: TripPendingSelections
}

export type TripState = TripIdleState | TripSelectingState | TripLoadingState | TripResultsState

export type TripResultsInput = Omit<TripResultsState, 'phase' | 'selectedDirectIndex' | 'selectedTransferIndex' | 'pending'> & {
  selectedDirectIndex?: number
  selectedTransferIndex?: number
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
  return {
    phase: 'results',
    from: input.from,
    to: input.to,
    directRoutes: input.directRoutes,
    transferPlans: input.transferPlans,
    selectedDirectIndex: normalizeTripResultIndex(input.selectedDirectIndex, input.directRoutes.length),
    selectedTransferIndex: normalizeTripResultIndex(input.selectedTransferIndex, input.transferPlans.length),
    warning: input.warning,
    pending: input.pending ?? {},
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
  input: Pick<
    TripResultsState,
    'directRoutes' | 'transferPlans' | 'selectedDirectIndex' | 'selectedTransferIndex' | 'warning'
  >,
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
  return {
    ...state,
    selectedDirectIndex: normalizeTripResultIndex(index, state.directRoutes.length),
  }
}

export function selectTransferTripResult(state: TripResultsState, index: number): TripResultsState {
  return {
    ...state,
    selectedTransferIndex: normalizeTripResultIndex(index, state.transferPlans.length),
  }
}

export function hasTripResultsState(state: TripState): state is TripResultsState {
  return state.phase === 'results'
    && Boolean(state.directRoutes.length || state.transferPlans.length)
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
