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
const MAX_STOP_ARRIVAL_RECORDS = 500
const STOP_ARRIVAL_SELECT = [
  'RouteUID',
  'SubRouteUID',
  'StopUID',
  'Direction',
  'EstimateTime',
  'StopStatus',
  'DataTime',
  'SrcUpdateTime',
  'SrcTransTime',
  'UpdateTime',
].join(',')

export function buildStopArrivalBatches(
  city: string,
  candidates: StopArrivalCandidate[],
  maxStopUidsPerBatch = MAX_STOP_UIDS_PER_BATCH,
): StopArrivalBatch[] {
  const safeBatchSize = Math.max(1, Math.floor(maxStopUidsPerBatch))
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
        batches.push({
          scope,
          stopUids: chunk,
          candidates: scopedCandidates.filter((candidate) => allowed.has(candidate.stopUid)),
          cacheKey: `stop-batch:v1:${scope}:${chunk.join(',')}`,
          url: stopArrivalBatchUrl(scope, chunk),
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
    return typeof record.StopUID === 'string'
      && allowed.has(record.StopUID)
      && optionalString(record.RouteUID)
      && optionalString(record.SubRouteUID)
      && optionalNumber(record.Direction)
      && optionalNullableNumber(record.EstimateTime)
      && optionalNumber(record.StopStatus)
      && optionalString(record.DataTime)
      && optionalString(record.SrcUpdateTime)
      && optionalString(record.SrcTransTime)
      && optionalString(record.UpdateTime)
  })
}

function stopArrivalBatchUrl(scope: string, stopUids: readonly string[]): URL {
  const url = new URL(`https://tdx.transportdata.tw/api/basic/v2/Bus/EstimatedTimeOfArrival/${scope}`)
  url.searchParams.set('$filter', stopUids
    .map((stopUid) => `StopUID eq '${escapeODataString(stopUid)}'`)
    .join(' or '))
  url.searchParams.set('$select', STOP_ARRIVAL_SELECT)
  url.searchParams.set('$format', 'JSON')
  return url
}

function escapeODataString(value: string): string {
  return value.replaceAll("'", "''")
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

function optionalNullableNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number'
}

function scopeRank(scope: string): number {
  return scope.startsWith('City/') ? 0 : 1
}
