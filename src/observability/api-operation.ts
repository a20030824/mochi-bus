import type { ReleaseIdentity } from './release-identity'
import {
  createTelemetryEnvelope,
  emitTelemetry,
  httpStatusClass,
  latencyBucket,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryCacheResult,
  type TelemetryCity,
  type TelemetryEmptyReason,
  type TelemetryEnvelope,
  type TelemetryFailureClass,
  type TelemetryOperation,
  type TelemetryQualityBucket,
  type TelemetryResult,
  type TelemetrySink,
  type TelemetrySource,
  type TelemetryTrafficClass,
} from './telemetry'

export const ORGANIC_API_SAMPLE_PROBABILITY = 0.1

export type ApiOperationOutcome = Readonly<{
  result: TelemetryResult
  source: TelemetrySource
  httpStatus: number
  failureClass?: TelemetryFailureClass
  cacheResult?: TelemetryCacheResult
  emptyReason?: TelemetryEmptyReason
  qualityBucket?: TelemetryQualityBucket
  snapshotVersion?: string | null
  city?: TelemetryCity | null
}>

export type ApiOperationTracker = Readonly<{
  isSampled: boolean
  complete: (outcome: ApiOperationOutcome) => boolean
  completeMissing: (httpStatus?: number) => boolean
}>

type BeginApiOperationOptions = Readonly<{
  operation: TelemetryOperation
  city: TelemetryCity | null
  trafficClass: TelemetryTrafficClass
  releaseIdentity: ReleaseIdentity
  snapshotVersion?: string | null
  sampleProbability?: number
  now?: () => number
  random?: () => number
  emitter?: TelemetrySink
}>

export function beginApiOperationTelemetry(options: BeginApiOperationOptions): ApiOperationTracker {
  const now = options.now ?? Date.now
  const startedAt = safeNow(now)
  const sampleProbability = samplingProbability(options.trafficClass, options.sampleProbability)
  const isSampled = decideSample(options.trafficClass, sampleProbability, options.random ?? Math.random)
  let completed = false

  const complete = (outcome: ApiOperationOutcome): boolean => {
    if (completed) return false
    completed = true
    if (!isSampled) return false

    try {
      const finishedAt = safeNow(now)
      const elapsed = startedAt === null || finishedAt === null ? Number.NaN : Math.max(0, finishedAt - startedAt)
      const event = createTelemetryEnvelope(options.releaseIdentity, {
        eventSchema: TELEMETRY_EVENT_SCHEMA,
        event: 'api_operation_completed',
        city: outcome.city === undefined ? options.city : outcome.city,
        operation: options.operation,
        result: outcome.result,
        source: outcome.source,
        snapshotVersion: safeSnapshotVersion(
          outcome.snapshotVersion === undefined
            ? options.snapshotVersion ?? null
            : outcome.snapshotVersion,
        ),
        httpStatusClass: httpStatusClass(outcome.httpStatus),
        latencyBucket: latencyBucket(elapsed),
        cacheResult: outcome.cacheResult ?? 'unknown',
        trafficClass: options.trafficClass,
        sampleProbability,
        failureClass: outcome.failureClass ?? (outcome.result === 'error' ? 'unknown' : 'none'),
        emptyReason: outcome.emptyReason ?? 'not_applicable',
        qualityBucket: outcome.qualityBucket ?? 'not_applicable',
      })
      if (!event) return false
      return emitEvent(event, options.emitter)
    } catch {
      return false
    }
  }

  return Object.freeze({
    isSampled,
    complete,
    completeMissing: (httpStatus = 500) => complete({
      result: 'error',
      source: 'none',
      httpStatus,
      failureClass: 'completion_missing',
    }),
  })
}

function samplingProbability(trafficClass: TelemetryTrafficClass, configured?: number): number {
  if (trafficClass !== 'user') return 1
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 && configured <= 1
    ? configured
    : ORGANIC_API_SAMPLE_PROBABILITY
}

function decideSample(
  trafficClass: TelemetryTrafficClass,
  probability: number,
  random: () => number,
): boolean {
  if (trafficClass !== 'user') return true
  try {
    const value = random()
    return Number.isFinite(value) && value >= 0 && value < probability
  } catch {
    return false
  }
}

function safeNow(now: () => number): number | null {
  try {
    const value = now()
    return Number.isFinite(value) ? value : null
  } catch {
    return null
  }
}

function safeSnapshotVersion(value: string | null): string | null {
  if (value === null) return null
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !/(?:authorization|bearer\s|client[ _-]?secret|access[ _-]?token|cf-connecting-ip)/i.test(value)
    ? value
    : null
}

function emitEvent(event: TelemetryEnvelope, emitter?: TelemetrySink): boolean {
  return emitter ? emitTelemetry(event, emitter) : emitTelemetry(event)
}
