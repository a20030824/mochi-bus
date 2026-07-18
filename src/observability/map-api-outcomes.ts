import type { JourneyEstimate } from '../domain/map/journey-estimate'
import type { TDXWarning } from '../lib/tdx'
import type {
  TelemetryEmptyReason,
  TelemetryFailureClass,
  TelemetryQualityBucket,
  TelemetryResult,
  TelemetrySource,
} from './telemetry'

type SemanticOutcome = Readonly<{
  result: TelemetryResult
  source: TelemetrySource
  failureClass: TelemetryFailureClass
  emptyReason: TelemetryEmptyReason
  qualityBucket: TelemetryQualityBucket
  snapshotVersion: string | null
}>

const baseOutcome = {
  failureClass: 'none',
  emptyReason: 'not_applicable',
  qualityBucket: 'not_applicable',
} as const

export function mapRoutesOutcome(input: {
  snapshotRouteCount: number
  routeCount: number
  snapshotVersion: string | null
}): SemanticOutcome {
  if (input.snapshotRouteCount > 0) {
    return { ...baseOutcome, result: 'success', source: 'snapshot', snapshotVersion: input.snapshotVersion }
  }
  if (input.routeCount > 0) {
    return { ...baseOutcome, result: 'degraded', source: 'fallback', snapshotVersion: null }
  }
  return {
    ...baseOutcome,
    result: 'empty',
    source: 'fallback',
    emptyReason: 'no_routes',
    snapshotVersion: null,
  }
}

export function vehiclesOutcome(input: {
  upstreamSucceeded: boolean
  rawCount: number
  identityMatchedCount: number
  validVehicleCount: number
  warning?: TDXWarning
}): SemanticOutcome {
  if (!input.upstreamSucceeded || input.warning) {
    return {
      ...baseOutcome,
      result: 'degraded',
      source: 'fallback',
      failureClass: failureClassFromWarning(input.warning),
      emptyReason: input.validVehicleCount === 0 ? 'upstream_failure' : 'not_applicable',
      snapshotVersion: null,
    }
  }
  if (input.rawCount === 0) return emptyRealtime('no_vehicles')
  if (input.identityMatchedCount === 0) return emptyRealtime('identity_mismatch')
  if (input.validVehicleCount === 0) return emptyRealtime('invalid_coordinates')
  return { ...baseOutcome, result: 'success', source: 'realtime', snapshotVersion: null }
}

export function placeArrivalsOutcome(input: {
  bundleUsed: boolean
  sources: ReadonlyArray<'realtime' | 'stale-realtime' | 'schedule' | 'none'>
  warning?: TDXWarning
  snapshotVersion: string | null
}): SemanticOutcome {
  const usableSources = input.sources.filter((source) => source !== 'none')
  if (!usableSources.length) {
    if (input.warning) {
      return {
        ...baseOutcome,
        result: 'degraded',
        source: 'fallback',
        failureClass: failureClassFromWarning(input.warning),
        emptyReason: 'upstream_failure',
        snapshotVersion: input.snapshotVersion,
      }
    }
    if (!input.bundleUsed) {
      return {
        ...baseOutcome,
        result: 'degraded',
        source: 'fallback',
        emptyReason: 'route_object_fallback',
        snapshotVersion: null,
      }
    }
    return {
      ...baseOutcome,
      result: 'empty',
      source: 'none',
      emptyReason: 'no_arrivals',
      snapshotVersion: input.snapshotVersion,
    }
  }

  const source = input.bundleUsed ? arrivalSource(usableSources) : 'fallback'
  const degraded = Boolean(input.warning) || !input.bundleUsed || source !== 'realtime'
  return {
    ...baseOutcome,
    result: degraded ? 'degraded' : 'success',
    source,
    failureClass: failureClassFromWarning(input.warning),
    snapshotVersion: input.snapshotVersion,
  }
}

export function journeyEtaOutcome(input: {
  estimates: ReadonlyArray<JourneyEstimate | undefined>
  expectedCount?: number
  warning?: TDXWarning
}): SemanticOutcome {
  const known = input.estimates.filter((estimate): estimate is JourneyEstimate => Boolean(
    estimate && estimate.source !== 'none' && estimate.minutes !== null,
  ))
  const expectedCount = Number.isInteger(input.expectedCount) && (input.expectedCount ?? 0) >= 0
    ? Math.max(input.expectedCount ?? 0, input.estimates.length)
    : input.estimates.length
  const unknownCount = expectedCount - known.length
  if (!expectedCount || unknownCount === expectedCount) {
    if (input.warning) {
      return {
        ...baseOutcome,
        result: 'degraded',
        source: 'fallback',
        failureClass: failureClassFromWarning(input.warning),
        emptyReason: 'upstream_failure',
        qualityBucket: 'all_unknown',
        snapshotVersion: null,
      }
    }
    return {
      ...baseOutcome,
      result: 'empty',
      source: 'none',
      emptyReason: 'all_estimates_unknown',
      qualityBucket: 'all_unknown',
      snapshotVersion: null,
    }
  }

  const source = journeySource(known)
  const qualityBucket = journeyQuality(source, unknownCount)
  const degraded = Boolean(input.warning) || unknownCount > 0 || source !== 'realtime'
  return {
    ...baseOutcome,
    result: degraded ? 'degraded' : 'success',
    source,
    failureClass: failureClassFromWarning(input.warning),
    qualityBucket,
    snapshotVersion: null,
  }
}

export function failureClassFromWarning(warning?: TDXWarning): TelemetryFailureClass {
  if (warning === 'tdx-rate-limit') return 'tdx_429'
  if (warning === 'tdx-quota') return 'tdx_quota'
  return warning ? 'unknown' : 'none'
}

export function mapOperationErrorOutcome(failureClass: TelemetryFailureClass): SemanticOutcome {
  return {
    ...baseOutcome,
    result: 'error',
    source: 'none',
    failureClass: failureClass === 'none' ? 'unknown' : failureClass,
    snapshotVersion: null,
  }
}

function emptyRealtime(emptyReason: TelemetryEmptyReason): SemanticOutcome {
  return {
    ...baseOutcome,
    result: 'empty',
    source: 'realtime',
    emptyReason,
    snapshotVersion: null,
  }
}

function arrivalSource(
  sources: ReadonlyArray<'realtime' | 'stale-realtime' | 'schedule'>,
): TelemetrySource {
  const distinct = new Set(sources)
  if (distinct.size > 1) return 'mixed'
  const only = sources[0]
  if (only === 'stale-realtime') return 'stale'
  return only
}

function journeySource(estimates: ReadonlyArray<JourneyEstimate>): TelemetrySource {
  const sources = new Set(estimates.map((estimate) => estimate.source))
  if (sources.size > 1) return 'mixed'
  return sources.has('realtime') ? 'realtime' : 'schedule'
}

function journeyQuality(source: TelemetrySource, unknownCount: number): TelemetryQualityBucket {
  if (unknownCount > 0) return 'partial_unknown'
  if (source === 'realtime') return 'complete_realtime'
  if (source === 'schedule') return 'complete_schedule'
  return 'complete_mixed'
}
