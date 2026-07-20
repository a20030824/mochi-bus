import type { BusETAItem } from '../../lib/tdx'
import { tdxRouteScope } from '../../lib/tdx'

export type StopArrivalCandidate = {
  routeUid: string
  routeName: string
  stopUid: string
}

export type StopArrivalBatch = {
  scope: string
  stopUids: string[]
  candidates: StopArrivalCandidate[]
  cacheKey: string
  url: URL
}

const MAX_STOP_UIDS_PER_BATCH = 12
export const STOP_ARRIVAL_MAX_RESPONSE_BYTES = 512 * 1024
const MAX_STOP_ARRIVAL_RECORDS = 500
const STOP_ARRIVAL_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'Direction',
  'EstimateTime',
  'StopStatus',
].join(',')

export function buildStopArrivalBatches(
  city: string,
  candidates: StopArrivalCandidate[],
  maxStopUidsPerBatch = MAX_STOP_UIDS_PER_BATCH,
): StopArrivalBatch[] {
  const safeBatchSize = Number.isFinite(maxStopUidsPerBatch)
    ? Math.max(1, Math.floor(maxStopUidsPerBatch))
    : MAX_STOP_UIDS_PER_BATCH
  const candidatesByScope = new Map<string, StopArrivalCandidate[]>()

  for (const candidate of candidates) {
    const scope = tdxRouteScope(city, candidate.routeUid)
    const scoped = candidatesByScope.get(scope)
    if (scoped) scoped.push(candidate)
    else candidatesByScope.set(scope, [candidate])
  }

  return [...candidatesByScope.entries()]
    .sort(([a], [b]) => scopeRank(a) - scopeRank(b) || a.localeCompare(b))
    .flatMap(([scope, scopedCandidates]) => {
      const stopUids = [...new Set(scopedCandidates.map((candidate) => candidate.stopUid))].sort()
      const batches: StopArrivalBatch[] = []

      for (let index = 0; index < stopUids.length; index += safeBatchSize) {
        const chunk = stopUids.slice(index, index + safeBatchSize)
        const allowed = new Set(chunk)
        const batchCandidates = scopedCandidates.filter((candidate) => allowed.has(candidate.stopUid))
        const routeUids = [...new Set(batchCandidates.map((candidate) => candidate.routeUid))].sort()
        batches.push({
          scope,
          stopUids: chunk,
          candidates: batchCandidates,
          cacheKey: `stop-batch:v2:${scope}:${JSON.stringify(chunk)}:${JSON.stringify(routeUids)}`,
          url: stopArrivalBatchUrl(scope, chunk, routeUids),
        })
      }

      return batches
    })
}

export function isStopArrivalBatchPayload(
  value: unknown,
  allowedStopUids: readonly string[],
): value is BusETAItem[] {
  if (!Array.isArray(value) || value.length > MAX_STOP_ARRIVAL_RECORDS) return false
  const allowed = new Set(allowedStopUids)

  return value.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false
    const record = item as Record<string, unknown>
    return typeof record.RouteUID === 'string'
      && typeof record.StopUID === 'string'
      && allowed.has(record.StopUID)
      && optionalNullableString(record.SubRouteUID)
      && validDirection(record.Direction)
      && optionalNullableNumber(record.EstimateTime)
      && optionalNullableNumber(record.StopStatus)
  })
}

function stopArrivalBatchUrl(
  scope: string,
  stopUids: readonly string[],
  routeUids: readonly string[],
): URL {
  const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${scope}`)
  const stopFilter = stopUids
    .map((stopUid) => `StopUID eq '${escapeODataString(stopUid)}'`)
    .join(' or ')
  const routeFilter = routeUids
    .map((routeUid) => `RouteUID eq '${escapeODataString(routeUid)}'`)
    .join(' or ')
  url.searchParams.set('$filter', `(${stopFilter}) and (${routeFilter})`)
  url.searchParams.set('$select', STOP_ARRIVAL_SELECT)
  url.searchParams.set('$format', 'JSON')
  return url
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''")
}

function optionalNullableString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string'
}

function validDirection(value: unknown): boolean {
  return value === 0 || value === 1 || value === 2
}

function optionalNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number'
}

function scopeRank(scope: string): number {
  return scope.startsWith('City/') ? 0 : 1
}
