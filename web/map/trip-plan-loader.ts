import type { EtaSource } from '../../src/domain/eta-presentation'
import {
  estimateTransfer,
  transferEstimateSortKey,
} from '../../src/domain/map/transfer-estimate'
import type { TDXWarning } from '../../src/domain/tdx-warning'
import type {
  DirectRoute,
  JourneyEtaEstimate,
  TransferPlan,
} from './map-api-client'

export type TripPlanLoadPhase = 'direct' | 'transfer'

export type TripPlanLoadRequest = {
  cityCode: string
  fromPlaceId: string
  toPlaceId: string
  signal?: AbortSignal
  onPhase?: (phase: TripPlanLoadPhase) => void
}

export type TripPlanLoadResult =
  | { kind: 'direct'; routes: DirectRoute[]; warning?: TDXWarning }
  | { kind: 'transfer'; plans: TransferPlan[]; warning?: TDXWarning }
  | { kind: 'empty'; warning?: TDXWarning }

type JourneyEtaResponse = {
  estimates: JourneyEtaEstimate[]
  warning?: TDXWarning
}

type TripPlanLoaderOptions = {
  loadDirect: (
    cityCode: string,
    fromPlaceId: string,
    toPlaceId: string,
    signal?: AbortSignal,
  ) => Promise<DirectRoute[]>
  loadTransfer: (
    cityCode: string,
    fromPlaceId: string,
    toPlaceId: string,
    signal?: AbortSignal,
  ) => Promise<TransferPlan[]>
  loadJourneyEta: (
    cityCode: string,
    legs: Array<{ key: string; patternId: string; sequence: number }>,
    signal?: AbortSignal,
  ) => Promise<JourneyEtaResponse>
  isCredentialRejectedError: (error: unknown) => boolean
}

export type TripPlanLoader = {
  load(request: TripPlanLoadRequest): Promise<TripPlanLoadResult | undefined>
}

type JourneyEtaValue = Omit<JourneyEtaEstimate, 'key'> & { source: EtaSource }

type JourneyEtaLookup = {
  estimates: Map<string, JourneyEtaValue>
  warning?: TDXWarning
}

export function createTripPlanLoader(options: TripPlanLoaderOptions): TripPlanLoader {
  async function fetchJourneyEta(
    cityCode: string,
    legs: Array<{ key: string; patternId: string; sequence: number }>,
    signal?: AbortSignal,
  ): Promise<JourneyEtaLookup> {
    if (!legs.length) return { estimates: new Map() }
    try {
      const response = await options.loadJourneyEta(cityCode, legs, signal)
      return {
        warning: response.warning,
        estimates: new Map(response.estimates.map((estimate) => [
          estimate.key,
          {
            minutes: estimate.minutes,
            source: estimate.source,
            departureBased: estimate.departureBased ?? false,
            headwayMinutes: estimate.headwayMinutes ?? null,
            nextDay: estimate.nextDay ?? false,
          },
        ])),
      }
    } catch (error) {
      if (options.isCredentialRejectedError(error)) throw error
      return { estimates: new Map(), warning: 'tdx-unavailable' }
    }
  }

  async function rankDirectRoutes(
    cityCode: string,
    routes: DirectRoute[],
    signal?: AbortSignal,
  ): Promise<{ routes: DirectRoute[]; warning?: TDXWarning }> {
    const eta = await fetchJourneyEta(cityCode, routes.map((route, index) => ({
      key: `direct:${index}`,
      patternId: route.variantKey,
      sequence: route.boardSequence,
    })), signal)
    const ranked = routes.map((route, index) => {
      const estimate = eta.estimates.get(`direct:${index}`)
      return {
        ...route,
        etaMinutes: estimate?.minutes ?? null,
        etaSource: estimate?.source ?? 'none',
        etaDepartureBased: estimate?.departureBased ?? false,
        etaHeadwayMinutes: estimate?.headwayMinutes ?? null,
        etaNextDay: estimate?.nextDay ?? false,
      }
    }).sort((a, b) =>
      sortableJourneyMinutes(a) - sortableJourneyMinutes(b)
      || a.stopCount - b.stopCount,
    )
    return { routes: ranked, warning: eta.warning }
  }

  async function rankTransferPlans(
    cityCode: string,
    plans: TransferPlan[],
    signal?: AbortSignal,
  ): Promise<{ plans: TransferPlan[]; warning?: TDXWarning }> {
    const eta = await fetchJourneyEta(cityCode, plans.flatMap((plan, index) => [
      { key: `transfer:${index}:first`, patternId: plan.first.variantKey, sequence: plan.first.boardSequence },
      { key: `transfer:${index}:second`, patternId: plan.second.variantKey, sequence: plan.second.boardSequence },
    ]), signal)
    const ranked = plans.map((plan, index) => {
      const firstEstimate = eta.estimates.get(`transfer:${index}:first`)
      const secondEstimate = eta.estimates.get(`transfer:${index}:second`)
      const firstEta = firstEstimate?.minutes ?? null
      const secondEta = secondEstimate?.minutes ?? null
      const transferEstimate = estimateTransfer({
        firstStopCount: plan.first.stopCount,
        secondStopCount: plan.second.stopCount,
        walkMeters: plan.transferWalkMeters ?? 0,
        firstEtaMinutes: firstEta,
        secondEtaMinutes: secondEta,
        firstEtaReliable: isReliableJourneyArrival(firstEstimate),
        secondEtaReliable: isReliableJourneyArrival(secondEstimate),
      })
      return {
        ...plan,
        firstEtaMinutes: firstEta,
        secondEtaMinutes: secondEta,
        firstEtaSource: firstEstimate?.source ?? 'none',
        secondEtaSource: secondEstimate?.source ?? 'none',
        firstEtaDepartureBased: firstEstimate?.departureBased ?? false,
        secondEtaDepartureBased: secondEstimate?.departureBased ?? false,
        firstEtaHeadwayMinutes: firstEstimate?.headwayMinutes ?? null,
        secondEtaHeadwayMinutes: secondEstimate?.headwayMinutes ?? null,
        firstEtaNextDay: firstEstimate?.nextDay ?? false,
        secondEtaNextDay: secondEstimate?.nextDay ?? false,
        transferEstimate,
      }
    }).sort((a, b) =>
      transferEstimateSortKey(a.transferEstimate) - transferEstimateSortKey(b.transferEstimate)
      || a.totalStops - b.totalStops,
    )
    return { plans: ranked, warning: eta.warning }
  }

  async function load(request: TripPlanLoadRequest): Promise<TripPlanLoadResult | undefined> {
    request.onPhase?.('direct')
    const directRoutes = await options.loadDirect(
      request.cityCode,
      request.fromPlaceId,
      request.toPlaceId,
      request.signal,
    )
    if (request.signal?.aborted) return undefined
    if (directRoutes.length) {
      const ranked = await rankDirectRoutes(request.cityCode, directRoutes, request.signal)
      if (request.signal?.aborted) return undefined
      return { kind: 'direct', routes: ranked.routes, warning: ranked.warning }
    }

    request.onPhase?.('transfer')
    const transferPlans = await options.loadTransfer(
      request.cityCode,
      request.fromPlaceId,
      request.toPlaceId,
      request.signal,
    )
    if (request.signal?.aborted) return undefined
    if (!transferPlans.length) return { kind: 'empty' }
    const ranked = await rankTransferPlans(request.cityCode, transferPlans, request.signal)
    if (request.signal?.aborted) return undefined
    return { kind: 'transfer', plans: ranked.plans, warning: ranked.warning }
  }

  return { load }
}

function sortableJourneyMinutes(route: DirectRoute): number {
  if (route.etaSource !== 'realtime' && route.etaSource !== 'schedule') return Number.POSITIVE_INFINITY
  if (route.etaDepartureBased || route.etaHeadwayMinutes || route.etaNextDay) return Number.POSITIVE_INFINITY
  return route.etaMinutes ?? Number.POSITIVE_INFINITY
}

function isReliableJourneyArrival(estimate: JourneyEtaValue | undefined): boolean {
  return estimate?.source === 'realtime'
    && estimate.minutes !== null
    && !estimate.departureBased
    && !estimate.headwayMinutes
    && !estimate.nextDay
}
