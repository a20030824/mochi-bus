export type TripSelectionKind = 'from' | 'to'

type PlaceIdentity = {
  placeId: string
}

const SAME_TRIP_STOP_MESSAGE = '出發位置和目的地是同一站，請選另一個站牌'

/** Return a validation message without mutating either trip endpoint. */
export function getTripSelectionConflict(
  kind: TripSelectionKind,
  candidate: PlaceIdentity | undefined,
  selectedFrom: PlaceIdentity | undefined,
  selectedTo: PlaceIdentity | undefined,
): string | undefined {
  if (!candidate?.placeId) return undefined
  const conflictingPlace = kind === 'from' ? selectedTo : selectedFrom
  return conflictingPlace?.placeId === candidate.placeId
    ? SAME_TRIP_STOP_MESSAGE
    : undefined
}
