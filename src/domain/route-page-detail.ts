import type { ResolvedBusQuery } from './bus-query'
import {
  applyRouteTimelineFallback,
  ROUTE_UNKNOWN_ETA_LABEL,
  routeTimelineNeedsSchedule,
} from './route-timeline-fallback'
import {
  getBusSchedule,
  getRouteDetail,
  getRouteStopGroups,
  isRejectedUserTdxToken,
  QueryResolutionError,
  tdxWarningFromError,
  type RouteDetail,
  type StopGroup,
  type TDXEnv,
  type TDXWarning,
} from '../lib/tdx'
import type { ScheduleItem } from './schedule'

export type RouteEtaState =
  | { kind: 'realtime' }
  | { kind: 'empty' }
  | { kind: 'unavailable'; warning: TDXWarning }

export type RouteEtaDetail = {
  detail: RouteDetail
  eta: RouteEtaState
}

export type RouteEtaStop = Pick<
  RouteDetail['stops'][number],
  'stopUid' | 'stopName' | 'sequence' | 'etaLabel' | 'etaTone'
>

export type RouteEtaResponse = {
  schemaVersion: 1
  eta: RouteEtaState
  stops: RouteEtaStop[]
}

type RouteDetailDependencies = {
  getRouteStopGroups: typeof getRouteStopGroups
  getRouteDetail: typeof getRouteDetail
  getBusSchedule: typeof getBusSchedule
  now: () => Date
}

type RoutePageDetailDependencies = Pick<RouteDetailDependencies, 'getRouteStopGroups'>

const defaultDependencies: RouteDetailDependencies = {
  getRouteStopGroups,
  getRouteDetail,
  getBusSchedule,
  now: () => new Date(),
}

/**
 * Build the server-rendered Route page from static station order only.
 * Realtime ETA is deliberately loaded later through the authenticated API so
 * page navigation never consumes TDX realtime quota and BYOK can take effect.
 */
export async function getRoutePageDetail(
  env: TDXEnv,
  query: ResolvedBusQuery,
  dependencies: RoutePageDetailDependencies = defaultDependencies,
): Promise<{ detail: RouteDetail }> {
  const groups = await dependencies.getRouteStopGroups(env, query.city, query.routeName, query.routeUid)
  const group = matchingStopGroup(groups, query)
  if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
  return { detail: routeDetailWithoutEta(query, group, '更新中') }
}

/**
 * Add route-level realtime ETA as a fail-open enhancement for the browser API.
 * Successful requests reuse the station order already resolved inside
 * getRouteDetail. Exact stop-level timetable arrivals fill only provisional or
 * missing rows; origin-only departures and route-level headways are never
 * presented as station arrival times.
 */
export async function getRouteEtaDetail(
  env: TDXEnv,
  query: ResolvedBusQuery,
  dependencies: Partial<RouteDetailDependencies> = {},
): Promise<RouteEtaDetail> {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies }

  try {
    let detail = await resolvedDependencies.getRouteDetail(env, query)
    let schedules: ScheduleItem[] = []

    if (routeTimelineNeedsSchedule(detail.stops)) {
      try {
        schedules = await resolvedDependencies.getBusSchedule(env, query.city, query.routeName, query.routeUid)
      } catch (error) {
        if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error
        console.error(JSON.stringify({
          message: 'route_schedule_fallback_failed',
          city: query.city,
        }))
      }

      detail = {
        ...detail,
        stops: applyRouteTimelineFallback(detail.stops, schedules, {
          direction: query.direction,
          subRouteUid: query.subRouteUid,
        }, resolvedDependencies.now()),
      }
    }

    if (detail.stops.some((stop) => stop.etaTone === 'live' || stop.etaTone === 'urgent')) {
      return { detail, eta: { kind: 'realtime' } }
    }
    return {
      detail: withSelectedStopStatusWhenUnknown(detail, '暫無即時'),
      eta: { kind: 'empty' },
    }
  } catch (error) {
    if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error

    const warning = tdxWarningFromError(error)
    if (!warning) throw error

    const groups = await resolvedDependencies.getRouteStopGroups(env, query.city, query.routeName, query.routeUid)
    const group = matchingStopGroup(groups, query)
    if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')

    console.error(JSON.stringify({
      message: 'route_eta_failed',
      city: query.city,
      warning,
    }))

    return {
      detail: routeDetailWithoutEta(query, group, unavailableLabel(warning)),
      eta: { kind: 'unavailable', warning },
    }
  }
}

export function toRouteEtaResponse(result: RouteEtaDetail): RouteEtaResponse {
  return {
    schemaVersion: 1,
    eta: result.eta,
    stops: result.detail.stops.map((stop) => ({
      stopUid: stop.stopUid,
      stopName: stop.stopName,
      sequence: stop.sequence,
      etaLabel: stop.etaLabel,
      etaTone: stop.etaTone,
    })),
  }
}

function matchingStopGroup(groups: StopGroup[], query: ResolvedBusQuery): StopGroup | undefined {
  return groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid),
  ) ?? (!query.subRouteUid ? groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  ) : undefined)
}

function routeDetailWithoutEta(
  query: ResolvedBusQuery,
  group: StopGroup,
  selectedStatus: string,
): RouteDetail {
  return {
    routeName: query.routeName,
    direction: query.direction,
    label: group.label,
    stops: group.stops.map((stop) => ({
      stopUid: stop.stopUid,
      stopName: stop.stopName,
      sequence: stop.sequence,
      selected: stop.stopUid === query.stopUid,
      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    })),
  }
}

function withSelectedStopStatusWhenUnknown(detail: RouteDetail, selectedStatus: string): RouteDetail {
  return {
    ...detail,
    stops: detail.stops.map((stop) => stop.selected
      && (stop.etaLabel === null || stop.etaLabel === ROUTE_UNKNOWN_ETA_LABEL)
      ? { ...stop, etaLabel: selectedStatus, etaTone: 'muted' }
      : stop),
  }
}

function unavailableLabel(warning: TDXWarning): string {
  if (warning === 'tdx-quota') return '額度不可用'
  if (warning === 'tdx-rate-limit') return '即時忙線'
  return '即時未更新'
}
