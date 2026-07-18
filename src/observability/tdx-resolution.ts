import type { ReleaseIdentity } from './release-identity'
import {
  createTelemetryEnvelope,
  emitTelemetry,
  latencyBucket,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryCity,
  type TelemetryCredentialScope,
  type TelemetryDataAgeBucket,
  type TelemetryEnvelope,
  type TelemetryFailureClass,
  type TelemetryResolution,
  type TelemetryResult,
  type TelemetrySink,
  type TelemetrySource,
  type TelemetryTdxOperation,
  type TelemetryTrafficClass,
} from './telemetry'

export const ORGANIC_TDX_SAMPLE_PROBABILITY = 0.1

export type TDXResolutionOutcome = Readonly<{
  resolution: TelemetryResolution
  result: TelemetryResult
  failureClass?: TelemetryFailureClass
  initialFailureClass?: TelemetryFailureClass
  retryCount?: number
  recoveredAfterRetry?: boolean
  dataAgeMilliseconds?: number | null
  upstreamStatus?: number
}>

export type TDXResolutionTracker = Readonly<{
  isSampled: boolean
  complete: (outcome: TDXResolutionOutcome) => boolean
}>

export type BeginTDXResolutionOptions = Readonly<{
  tdxOperation: TelemetryTdxOperation
  credentialScope: TelemetryCredentialScope
  city: TelemetryCity | null
  trafficClass: TelemetryTrafficClass
  releaseIdentity: ReleaseIdentity
  sampleProbability?: number
  now?: () => number
  random?: () => number
  emitter?: TelemetrySink
}>

export function beginTDXResolutionTelemetry(options: BeginTDXResolutionOptions): TDXResolutionTracker {
  const now = options.now ?? Date.now
  const startedAt = safeNow(now)
  const probability = samplingProbability(options.trafficClass, options.sampleProbability)
  const isSampled = decideSample(options.trafficClass, probability, options.random ?? Math.random)
  let completed = false

  const complete = (outcome: TDXResolutionOutcome): boolean => {
    if (completed) return false
    completed = true
    if (!isSampled) return false
    try {
      const finishedAt = safeNow(now)
      const elapsed = startedAt === null || finishedAt === null ? Number.NaN : Math.max(0, finishedAt - startedAt)
      const retryCount = normalizeRetryCount(outcome.retryCount)
      const failureClass = outcome.failureClass
        ?? (outcome.result === 'error' || outcome.result === 'degraded' ? 'unknown' : 'none')
      const event = createTelemetryEnvelope(options.releaseIdentity, {
        eventSchema: TELEMETRY_EVENT_SCHEMA,
        event: 'tdx_resolution_completed',
        city: options.city,
        operation: telemetryOperation(options.tdxOperation),
        result: outcome.result,
        source: telemetrySource(options.tdxOperation, outcome.resolution, outcome.result),
        snapshotVersion: null,
        httpStatusClass: 'none',
        latencyBucket: latencyBucket(elapsed),
        cacheResult: cacheResult(outcome.resolution),
        trafficClass: options.trafficClass,
        sampleProbability: probability,
        failureClass,
        emptyReason: outcome.result === 'empty' ? 'tdx_empty'
          : outcome.result === 'degraded' ? 'upstream_failure'
            : 'not_applicable',
        qualityBucket: 'not_applicable',
        tdxOperation: options.tdxOperation,
        credentialScope: options.credentialScope,
        resolution: outcome.resolution,
        retryCountBucket: retryBucket(retryCount),
        recoveredAfterRetry: outcome.recoveredAfterRetry ?? (retryCount > 0 && (
          outcome.result === 'success' || outcome.result === 'empty'
        )),
        dataAgeBucket: dataAgeBucket(outcome.dataAgeMilliseconds),
        upstreamStatusClass: upstreamStatusClass(outcome.upstreamStatus),
        ...(retryCount > 0 ? { initialFailureClass: outcome.initialFailureClass ?? 'unknown' } : {}),
      })
      if (!event) return false
      return options.emitter ? emitTelemetry(event, options.emitter) : emitTelemetry(event)
    } catch {
      return false
    }
  }

  return Object.freeze({ isSampled, complete })
}

export function dataAgeBucket(milliseconds: number | null | undefined): TelemetryDataAgeBucket {
  if (milliseconds === null) return 'not_applicable'
  if (milliseconds === undefined || !Number.isFinite(milliseconds) || milliseconds < 0) return 'unknown'
  if (milliseconds < 1_000) return 'fresh'
  if (milliseconds < 60_000) return 'lt_1m'
  if (milliseconds < 5 * 60_000) return '1_5m'
  if (milliseconds < 30 * 60_000) return '5_30m'
  if (milliseconds < 6 * 60 * 60_000) return '30m_6h'
  return 'gt_6h'
}

function telemetryOperation(operation: TelemetryTdxOperation) {
  if (operation === 'route_catalog') return 'map_routes' as const
  if (operation === 'place_arrivals') return 'map_place_arrivals' as const
  if (operation === 'vehicle_positions') return 'map_vehicles' as const
  if (operation === 'journey_eta') return 'map_journey_eta' as const
  return 'map_timetable' as const
}

function telemetrySource(
  operation: TelemetryTdxOperation,
  resolution: TelemetryResolution,
  result: TelemetryResult,
): TelemetrySource {
  if (result === 'error') return 'none'
  if (resolution === 'stale_replay') return 'stale'
  if (operation === 'route_catalog') return 'tdx_static'
  if (operation === 'tdx_schedule') return 'schedule'
  return 'realtime'
}

function cacheResult(resolution: TelemetryResolution) {
  if (resolution === 'memory') return 'memory_hit' as const
  if (resolution === 'edge') return 'edge_hit' as const
  if (resolution === 'upstream') return 'miss' as const
  return 'bypass' as const
}

function upstreamStatusClass(status: number | undefined) {
  if (!Number.isInteger(status) || status === undefined) return 'none' as const
  if (status >= 200 && status <= 299) return '2xx' as const
  if (status >= 400 && status <= 499) return '4xx' as const
  if (status >= 500 && status <= 599) return '5xx' as const
  return 'none' as const
}

function retryBucket(count: number) {
  if (count <= 0) return '0' as const
  if (count === 1) return '1' as const
  return '2_plus' as const
}

function normalizeRetryCount(value: number | undefined): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : 0
}

function samplingProbability(trafficClass: TelemetryTrafficClass, configured?: number): number {
  if (trafficClass !== 'user') return 1
  return typeof configured === 'number' && Number.isFinite(configured) && configured > 0 && configured <= 1
    ? configured
    : ORGANIC_TDX_SAMPLE_PROBABILITY
}

function decideSample(trafficClass: TelemetryTrafficClass, probability: number, random: () => number): boolean {
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
