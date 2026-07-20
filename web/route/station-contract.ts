export const ROUTE_STATION_LIMITS = {
  maxStops: 1_000,
  maxStopUidLength: 128,
  maxStopNameLength: 256,
} as const

export type RouteStationBase = {
  stopUid: string
  stopName: string
  sequence: number
}

export type RouteStationEnvelope = {
  record: Record<string, unknown>
  stops: unknown[]
}

export function parseRouteStationEnvelope(value: unknown): RouteStationEnvelope | null {
  if (!isRouteRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.stops)
    || value.stops.length === 0
    || value.stops.length > ROUTE_STATION_LIMITS.maxStops) {
    return null
  }
  return { record: value, stops: value.stops }
}

export function parseRouteStationBase(value: unknown): RouteStationBase | null {
  if (!isRouteRecord(value)
    || typeof value.stopUid !== 'string'
    || value.stopUid.length === 0
    || value.stopUid.length > ROUTE_STATION_LIMITS.maxStopUidLength
    || typeof value.stopName !== 'string'
    || value.stopName.length === 0
    || value.stopName.length > ROUTE_STATION_LIMITS.maxStopNameLength
    || typeof value.sequence !== 'number'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0) {
    return null
  }
  return {
    stopUid: value.stopUid,
    stopName: value.stopName,
    sequence: value.sequence,
  }
}

export function hasStrictlyIncreasingRouteSequence(
  stops: readonly RouteStationBase[],
): boolean {
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index].sequence <= stops[index - 1].sequence) return false
  }
  return true
}

export function isRouteRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
