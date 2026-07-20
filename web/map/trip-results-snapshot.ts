import type { TransferEstimate } from '../../src/domain/map/transfer-estimate'
import { tdxWarningMessages, type TDXWarning } from '../../src/domain/tdx-warning'
import type { DirectRoute, NearbyPlace, TransferPlan } from './map-api-client'
import {
  createTripResultsState,
  type TripCoordinate,
  type TripResultsState,
} from './trip-state'

export const TRIP_RESULTS_SNAPSHOT_MAX_AGE_MS = 15 * 60 * 1000

export type TripResultsHistorySnapshot = {
  version: 1
  savedAt: number
  city: string
  from: NearbyPlace
  to: NearbyPlace
  fromCoordinate?: TripCoordinate
  toCoordinate?: TripCoordinate
  directRoutes: DirectRoute[]
  transferPlans: TransferPlan[]
  selectedDirectIndex: number
  selectedTransferIndex: number
  warning?: TDXWarning
}

type ParseTripResultsSnapshotOptions = {
  city: string
  now?: number
  maxAgeMs?: number
  fromPlaceId?: string | null
  toPlaceId?: string | null
}

export function createTripResultsSnapshot(
  city: string,
  state: TripResultsState,
  now = Date.now(),
): TripResultsHistorySnapshot {
  return {
    version: 1,
    savedAt: now,
    city,
    from: state.from.place,
    to: state.to.place,
    fromCoordinate: state.from.coordinate,
    toCoordinate: state.to.coordinate,
    directRoutes: state.directRoutes,
    transferPlans: state.transferPlans,
    selectedDirectIndex: state.selectedDirectIndex,
    selectedTransferIndex: state.selectedTransferIndex,
    warning: state.warning,
  }
}

export function parseTripResultsSnapshot(
  value: unknown,
  options: ParseTripResultsSnapshotOptions,
): TripResultsState | undefined {
  if (!value || typeof value !== 'object') return undefined
  const snapshot = value as Partial<TripResultsHistorySnapshot>
  const now = options.now ?? Date.now()
  const maxAgeMs = options.maxAgeMs ?? TRIP_RESULTS_SNAPSHOT_MAX_AGE_MS

  if (snapshot.version !== 1
    || typeof snapshot.savedAt !== 'number'
    || !Number.isFinite(snapshot.savedAt)
    || now - snapshot.savedAt >= maxAgeMs
    || snapshot.city !== options.city
    || !isHistoryPlace(snapshot.from)
    || !isHistoryPlace(snapshot.to)
    || !isHistoryCoordinate(snapshot.fromCoordinate)
    || !isHistoryCoordinate(snapshot.toCoordinate)
    || !Array.isArray(snapshot.directRoutes)
    || snapshot.directRoutes.length > 30
    || !snapshot.directRoutes.every(isHistoryDirectRoute)
    || !Array.isArray(snapshot.transferPlans)
    || snapshot.transferPlans.length > 10
    || !snapshot.transferPlans.every(isHistoryTransferPlan)
    || (options.fromPlaceId && options.fromPlaceId !== snapshot.from.placeId)
    || (options.toPlaceId && options.toPlaceId !== snapshot.to.placeId)) {
    return undefined
  }

  return createTripResultsState({
    from: {
      place: snapshot.from,
      coordinate: snapshot.fromCoordinate,
    },
    to: {
      place: snapshot.to,
      coordinate: snapshot.toCoordinate,
    },
    directRoutes: snapshot.directRoutes,
    transferPlans: snapshot.transferPlans,
    selectedDirectIndex: snapshot.selectedDirectIndex,
    selectedTransferIndex: snapshot.selectedTransferIndex,
    warning: isHistoryWarning(snapshot.warning) ? snapshot.warning : undefined,
  })
}

function isHistoryCoordinate(value: unknown): value is TripCoordinate | undefined {
  return value === undefined || (Array.isArray(value)
    && value.length === 2
    && value.every((coordinate) => typeof coordinate === 'number' && Number.isFinite(coordinate)))
}

function isHistoryPlace(value: unknown): value is NearbyPlace {
  if (!value || typeof value !== 'object') return false
  const place = value as Partial<NearbyPlace>
  return typeof place.placeId === 'string'
    && typeof place.name === 'string'
    && typeof place.latitude === 'number' && Number.isFinite(place.latitude)
    && typeof place.longitude === 'number' && Number.isFinite(place.longitude)
}

function isHistoryLeg(value: unknown): value is TransferPlan['first'] {
  if (!value || typeof value !== 'object') return false
  const leg = value as Partial<TransferPlan['first']>
  return typeof leg.routeName === 'string'
    && typeof leg.variantKey === 'string'
    && typeof leg.label === 'string'
    && typeof leg.boardSequence === 'number'
    && typeof leg.alightSequence === 'number'
    && typeof leg.stopCount === 'number'
}

function isHistoryEtaSource(value: unknown): boolean {
  return value === undefined || value === 'none' || value === 'realtime'
    || value === 'stale-realtime' || value === 'schedule'
}

function isHistoryMinute(value: unknown): boolean {
  return value === undefined || value === null
    || (typeof value === 'number' && Number.isFinite(value) && value >= 0)
}

function isHistoryHeadway(value: unknown): boolean {
  return value === undefined || value === null || (Array.isArray(value)
    && value.length === 2
    && value.every((minute) => typeof minute === 'number' && Number.isFinite(minute) && minute >= 0))
}

function isHistoryDirectRoute(value: unknown): value is DirectRoute {
  if (!isHistoryLeg(value)) return false
  const route = value as Partial<DirectRoute>
  return isHistoryMinute(route.etaMinutes)
    && isHistoryEtaSource(route.etaSource)
    && isHistoryHeadway(route.etaHeadwayMinutes)
}

function isHistoryTransferEstimate(value: unknown): value is TransferEstimate {
  if (!value || typeof value !== 'object') return false
  const estimate = value as Partial<TransferEstimate>
  const validRange = (range: unknown) => Boolean(range
    && typeof range === 'object'
    && typeof (range as { min?: unknown }).min === 'number'
    && Number.isFinite((range as { min: number }).min)
    && typeof (range as { max?: unknown }).max === 'number'
    && Number.isFinite((range as { max: number }).max))
  return validRange(estimate.travelMinutes)
    && (estimate.totalMinutes === null || validRange(estimate.totalMinutes))
    && (estimate.connectionStatus === 'likely' || estimate.connectionStatus === 'tight'
      || estimate.connectionStatus === 'missed' || estimate.connectionStatus === 'unknown')
}

function isHistoryTransferPlan(value: unknown): value is TransferPlan {
  if (!value || typeof value !== 'object') return false
  const plan = value as Partial<TransferPlan>
  return typeof plan.transferPlaceId === 'string'
    && typeof plan.transferName === 'string'
    && typeof plan.totalStops === 'number'
    && isHistoryLeg(plan.first)
    && isHistoryLeg(plan.second)
    && isHistoryMinute(plan.firstEtaMinutes)
    && isHistoryMinute(plan.secondEtaMinutes)
    && isHistoryEtaSource(plan.firstEtaSource)
    && isHistoryEtaSource(plan.secondEtaSource)
    && isHistoryHeadway(plan.firstEtaHeadwayMinutes)
    && isHistoryHeadway(plan.secondEtaHeadwayMinutes)
    && (plan.transferEstimate === undefined || isHistoryTransferEstimate(plan.transferEstimate))
}

function isHistoryWarning(value: unknown): value is TDXWarning {
  return typeof value === 'string' && value in tdxWarningMessages
}
