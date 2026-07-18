import { supportedCities } from '../config'
import type { ReleaseIdentity } from './release-identity'

export const TELEMETRY_EVENT_SCHEMA = 1 as const

export const telemetryEvents = [
  'api_operation_completed',
  'tdx_resolution_completed',
  'snapshot_window_completed',
  'snapshot_probe_completed',
  'snapshot_fallback_selected',
  'rate_limit_decision',
  'circuit_state_changed',
  'release_smoke_completed',
  'frontend_boot_completed',
  'frontend_error',
] as const

export const telemetryOperations = [
  'map_routes',
  'map_route',
  'map_timetable',
  'map_network',
  'map_vehicles',
  'map_search',
  'map_nearby',
  'map_place_routes',
  'map_place_arrivals',
  'map_place',
  'map_stop_place',
  'map_direct',
  'map_transfer',
  'map_journey_eta',
  'bus_eta',
  'bus_stops',
  'bus_routes',
  'bus_stop_routes',
  'tdx_token',
  'tdx_realtime_eta',
  'tdx_vehicles',
  'snapshot_publish',
  'snapshot_validate',
  'snapshot_probe',
  'snapshot_rollback',
  'release_smoke',
  'frontend_boot',
  'frontend_runtime',
] as const

export const telemetryResults = ['success', 'degraded', 'empty', 'error'] as const

export const telemetrySources = [
  'realtime',
  'stale',
  'schedule',
  'snapshot',
  'fallback',
  'mixed',
  'browser',
  'worker',
  'none',
] as const

export const telemetryFailureClasses = [
  'none',
  'input_validation',
  'local_rate_limit',
  'tdx_401',
  'tdx_429',
  'tdx_quota',
  'tdx_timeout',
  'tdx_5xx',
  'tdx_invalid_json',
  'tdx_invalid_schema',
  'network',
  'd1',
  'r2',
  'cache',
  'contract_parse',
  'asset_load',
  'bootstrap',
  'unknown',
] as const

export const telemetryCacheResults = [
  'memory_hit',
  'edge_hit',
  'miss',
  'bypass',
  'error',
  'not_applicable',
] as const

export const telemetryLatencyBuckets = [
  'lt_50ms',
  '50_199ms',
  '200_999ms',
  '1_3s',
  '3_6s',
  'gt_6s',
  'unknown',
] as const

export const telemetryTrafficClasses = ['user', 'synthetic', 'snapshot_publish'] as const
export const telemetryHttpStatusClasses = ['2xx', '3xx', '4xx', '5xx', 'none'] as const

export type TelemetryEventName = typeof telemetryEvents[number]
export type TelemetryOperation = typeof telemetryOperations[number]
export type TelemetryResult = typeof telemetryResults[number]
export type TelemetrySource = typeof telemetrySources[number]
export type TelemetryFailureClass = typeof telemetryFailureClasses[number]
export type TelemetryCacheResult = typeof telemetryCacheResults[number]
export type TelemetryLatencyBucket = typeof telemetryLatencyBuckets[number]
export type TelemetryTrafficClass = typeof telemetryTrafficClasses[number]
export type TelemetryHttpStatusClass = typeof telemetryHttpStatusClasses[number]
export type TelemetryCity = typeof supportedCities[number][0]

export type TelemetryEnvelope = Readonly<{
  eventSchema: typeof TELEMETRY_EVENT_SCHEMA
  event: TelemetryEventName
  releaseSha: string | null
  workerVersionId: string | null
  workerCreatedAt: string | null
  deploymentId: string | null
  city: TelemetryCity | null
  operation: TelemetryOperation
  result: TelemetryResult
  source: TelemetrySource
  snapshotVersion: string | null
  httpStatusClass: TelemetryHttpStatusClass
  latencyBucket: TelemetryLatencyBucket
  cacheResult: TelemetryCacheResult
  trafficClass: TelemetryTrafficClass
  sampleProbability: number
  failureClass: TelemetryFailureClass
  errorFingerprint?: string
}>

export type TelemetrySink = (event: TelemetryEnvelope) => void
export type TelemetryEnvelopeFields = Omit<
  TelemetryEnvelope,
  'releaseSha' | 'workerVersionId' | 'workerCreatedAt' | 'deploymentId'
>

type AllowedKey = keyof TelemetryEnvelope

const allowedKeys = new Set<AllowedKey>([
  'eventSchema',
  'event',
  'releaseSha',
  'workerVersionId',
  'workerCreatedAt',
  'deploymentId',
  'city',
  'operation',
  'result',
  'source',
  'snapshotVersion',
  'httpStatusClass',
  'latencyBucket',
  'cacheResult',
  'trafficClass',
  'sampleProbability',
  'failureClass',
  'errorFingerprint',
])

const requiredKeys = new Set<AllowedKey>([
  'eventSchema',
  'event',
  'releaseSha',
  'workerVersionId',
  'workerCreatedAt',
  'deploymentId',
  'city',
  'operation',
  'result',
  'source',
  'snapshotVersion',
  'httpStatusClass',
  'latencyBucket',
  'cacheResult',
  'trafficClass',
  'sampleProbability',
  'failureClass',
])

const cityCodes = new Set<string>(supportedCities.map(([code]) => code))
const events = new Set<string>(telemetryEvents)
const operations = new Set<string>(telemetryOperations)
const results = new Set<string>(telemetryResults)
const sources = new Set<string>(telemetrySources)
const failureClasses = new Set<string>(telemetryFailureClasses)
const cacheResults = new Set<string>(telemetryCacheResults)
const latencyBuckets = new Set<string>(telemetryLatencyBuckets)
const trafficClasses = new Set<string>(telemetryTrafficClasses)
const httpStatusClasses = new Set<string>(telemetryHttpStatusClasses)

const safeIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const safeReleaseSha = /^[a-f0-9]{40}$/
const safeErrorFingerprint = /^err_[a-f0-9]{16}$/
const sensitiveMarker = /(?:authorization|bearer\s|client[ _-]?secret|access[ _-]?token|cf-connecting-ip)/i
const safeIsoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
const allowedErrorTypes = new Set([
  'Error',
  'TypeError',
  'SyntaxError',
  'ReferenceError',
  'RangeError',
  'URIError',
  'AggregateError',
  'DOMException',
  'NetworkError',
  'AbortError',
])

export function parseTelemetryEvent(input: unknown): TelemetryEnvelope | undefined {
  try {
    const value = recordOf(input)
    if (!value || !hasExactAllowedKeys(value)) return undefined
    if (value.eventSchema !== TELEMETRY_EVENT_SCHEMA) return undefined
    if (!enumValue(value.event, events)) return undefined
    if (!nullableIdentifier(value.releaseSha, safeReleaseSha)) return undefined
    if (!nullableIdentifier(value.workerVersionId, safeIdentifier)) return undefined
    if (!nullableIdentifier(value.workerCreatedAt, safeIsoTimestamp)) return undefined
    if (!nullableIdentifier(value.deploymentId, safeIdentifier)) return undefined
    if (!(value.city === null || enumValue(value.city, cityCodes))) return undefined
    if (!enumValue(value.operation, operations)) return undefined
    if (!enumValue(value.result, results)) return undefined
    if (!enumValue(value.source, sources)) return undefined
    if (!nullableIdentifier(value.snapshotVersion, safeIdentifier)) return undefined
    if (!enumValue(value.httpStatusClass, httpStatusClasses)) return undefined
    if (!enumValue(value.latencyBucket, latencyBuckets)) return undefined
    if (!enumValue(value.cacheResult, cacheResults)) return undefined
    if (!enumValue(value.trafficClass, trafficClasses)) return undefined
    if (!sampleProbability(value.sampleProbability)) return undefined
    if (!enumValue(value.failureClass, failureClasses)) return undefined
    if (value.errorFingerprint !== undefined && !identifier(value.errorFingerprint, safeErrorFingerprint)) return undefined

    return Object.freeze({
      eventSchema: TELEMETRY_EVENT_SCHEMA,
      event: value.event as TelemetryEventName,
      releaseSha: value.releaseSha as string | null,
      workerVersionId: value.workerVersionId as string | null,
      workerCreatedAt: value.workerCreatedAt as string | null,
      deploymentId: value.deploymentId as string | null,
      city: value.city as TelemetryCity | null,
      operation: value.operation as TelemetryOperation,
      result: value.result as TelemetryResult,
      source: value.source as TelemetrySource,
      snapshotVersion: value.snapshotVersion as string | null,
      httpStatusClass: value.httpStatusClass as TelemetryHttpStatusClass,
      latencyBucket: value.latencyBucket as TelemetryLatencyBucket,
      cacheResult: value.cacheResult as TelemetryCacheResult,
      trafficClass: value.trafficClass as TelemetryTrafficClass,
      sampleProbability: value.sampleProbability as number,
      failureClass: value.failureClass as TelemetryFailureClass,
      ...(value.errorFingerprint === undefined ? {} : { errorFingerprint: value.errorFingerprint as string }),
    })
  } catch {
    return undefined
  }
}

export function createTelemetryEnvelope(
  identity: ReleaseIdentity,
  fields: TelemetryEnvelopeFields,
): TelemetryEnvelope | undefined {
  try {
    return parseTelemetryEvent({
      ...fields,
      releaseSha: identity.releaseSha,
      workerVersionId: identity.workerVersionId,
      workerCreatedAt: identity.workerCreatedAt,
      deploymentId: identity.deploymentId,
    })
  } catch {
    return undefined
  }
}

export function emitTelemetry(input: unknown, sink: TelemetrySink = (event) => console.log(event)): boolean {
  try {
    const event = parseTelemetryEvent(input)
    if (!event) return false
    sink(event)
    return true
  } catch {
    return false
  }
}

export function latencyBucket(milliseconds: number): TelemetryLatencyBucket {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 50) return 'lt_50ms'
  if (milliseconds < 200) return '50_199ms'
  if (milliseconds < 1_000) return '200_999ms'
  if (milliseconds < 3_000) return '1_3s'
  if (milliseconds <= 6_000) return '3_6s'
  return 'gt_6s'
}

export function httpStatusClass(status: number | undefined): TelemetryHttpStatusClass {
  if (!Number.isInteger(status) || status === undefined || status < 200 || status > 599) return 'none'
  return `${Math.floor(status / 100)}xx` as TelemetryHttpStatusClass
}

export async function errorFingerprint(input: {
  errorType: unknown
  assetUrl?: unknown
  line?: unknown
}): Promise<string | undefined> {
  try {
    const errorType = sanitizedErrorType(input.errorType)
    const asset = assetBasename(input.assetUrl)
    const line = lineBucket(input.line)
    const bytes = new TextEncoder().encode(`${errorType}|${asset}|${line}`)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const hex = [...new Uint8Array(digest)]
      .slice(0, 8)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
    return `err_${hex}`
  } catch {
    return undefined
  }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function hasExactAllowedKeys(value: Record<string, unknown>): boolean {
  const keys = Object.keys(value)
  return keys.every((key) => allowedKeys.has(key as AllowedKey))
    && [...requiredKeys].every((key) => Object.hasOwn(value, key))
}

function enumValue(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value)
}

function nullableIdentifier(value: unknown, pattern: RegExp): value is string | null {
  return value === null || identifier(value, pattern)
}

function identifier(value: unknown, pattern: RegExp): value is string {
  return typeof value === 'string'
    && pattern.test(value)
    && !sensitiveMarker.test(value)
}

function sampleProbability(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
    && value <= 1
}

function sanitizedErrorType(value: unknown): string {
  return typeof value === 'string' && allowedErrorTypes.has(value) ? value : 'Error'
}

function assetBasename(value: unknown): string {
  if (typeof value !== 'string' || !value) return 'unknown'
  try {
    const path = new URL(value, 'https://telemetry.invalid').pathname
    const basename = path.split('/').filter(Boolean).at(-1)
    return basename && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}\.(?:css|html|js|mjs|map)$/.test(basename)
      ? basename
      : 'unknown'
  } catch {
    return 'unknown'
  }
}

function lineBucket(value: unknown): string {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'unknown'
  if (value > 1_000) return '1001_plus'
  const start = Math.floor((value - 1) / 25) * 25 + 1
  return `${start}_${start + 24}`
}
