import { supportedCityCodes } from '../config'
import {
  telemetryFailureClasses,
  telemetryOperations,
  type TelemetryCity,
  type TelemetryFailureClass,
  type TelemetryOperation,
} from './telemetry'

export const productionErrorEvents = [
  'commute_eta_realtime_failed',
  'eta_schedule_fallback_failed',
  'route_map_failed',
] as const

const productionErrorTypes = [
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
  'TimeoutError',
  'TDXServiceError',
] as const

export type ProductionErrorEvent = typeof productionErrorEvents[number]
export type ProductionErrorType = typeof productionErrorTypes[number]
export type ProductionErrorRecord = Readonly<{
  event: ProductionErrorEvent
  operation: TelemetryOperation
  city: TelemetryCity | null
  failureClass: TelemetryFailureClass
  errorType: ProductionErrorType
}>

export type ProductionErrorSink = (record: ProductionErrorRecord) => void

type ProductionErrorInput = Readonly<{
  event: ProductionErrorEvent
  operation: TelemetryOperation
  city?: string | null
  error: unknown
  failureClass?: TelemetryFailureClass
}>

const events = new Set<string>(productionErrorEvents)
const operations = new Set<string>(telemetryOperations)
const failureClasses = new Set<string>(telemetryFailureClasses)
const errorTypes = new Set<string>(productionErrorTypes)

// Production diagnostics are deliberately smaller than telemetry events: fixed event and operation
// identities, a bounded city/failure class, and an allowlisted error type. Messages, stacks,
// routes, stops, URLs, request bodies, and credentials never cross this boundary.
export function logProductionError(
  input: ProductionErrorInput,
  sink: ProductionErrorSink = (record) => console.error(record),
): boolean {
  try {
    if (!events.has(input.event) || !operations.has(input.operation)) return false
    const requestedFailureClass = input.failureClass ?? productionFailureClass(input.error)
    const failureClass = failureClasses.has(requestedFailureClass) && requestedFailureClass !== 'none'
      ? requestedFailureClass
      : 'unknown'
    const record = Object.freeze({
      event: input.event,
      operation: input.operation,
      city: safeCity(input.city),
      failureClass,
      errorType: productionErrorType(input.error),
    }) satisfies ProductionErrorRecord
    sink(record)
    return true
  } catch {
    return false
  }
}

export function productionFailureClass(error: unknown): TelemetryFailureClass {
  const value = recordOf(error)
  const explicitFailure = value?.failureKind
  if (typeof explicitFailure === 'string'
    && explicitFailure !== 'none'
    && failureClasses.has(explicitFailure)) {
    return explicitFailure as TelemetryFailureClass
  }

  if (value?.warning === 'tdx-quota') return 'quota'
  if (value?.warning === 'tdx-rate-limit') return 'rate_limited'

  const status = value?.status
  if (typeof status === 'number' && Number.isInteger(status)) {
    if (status === 401) return 'token_rejected'
    if (status === 429) return 'rate_limited'
    if (status >= 400 && status <= 499) return 'upstream_4xx'
    if (status >= 500 && status <= 599) return 'upstream_5xx'
  }

  const causeName = recordOf(value?.cause)?.name
  if (causeName === 'AbortError' || causeName === 'TimeoutError') return 'timeout'
  return value?.name === 'TDXServiceError' ? 'network_error' : 'unknown'
}

function productionErrorType(error: unknown): ProductionErrorType {
  const name = error instanceof Error ? error.name : recordOf(error)?.name
  return typeof name === 'string' && errorTypes.has(name)
    ? name as ProductionErrorType
    : 'Error'
}

function safeCity(value: string | null | undefined): TelemetryCity | null {
  return value && supportedCityCodes.has(value) ? value as TelemetryCity : null
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
