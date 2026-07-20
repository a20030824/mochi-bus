import type { ResolvedBusQuery } from './bus-query'
import {
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

export type RouteEtaState =
  | { kind: 'realtime' }
  | { kind: 'empty' }
  | { kind: 'unavailable'; warning: TDXWarning }

export type RoutePageDetail = {
  detail: RouteDetail
  eta: RouteEtaState
}

type RoutePageDetailDependencies = {
  getRouteStopGroups: typeof getRouteStopGroups
  getRouteDetail: typeof getRouteDetail
}

const defaultDependencies: RoutePageDetailDependencies = {
  getRouteStopGroups,
  getRouteDetail,
}

/**
 * Resolve static station order first, then add realtime ETA as a fail-open
 * enhancement. This keeps one cold StopOfRoute request and prevents a
 * transient ETA failure from removing an otherwise valid route timeline.
 */
export async function getRoutePageDetail(
  env: TDXEnv,
  query: ResolvedBusQuery,
  dependencies: RoutePageDetailDependencies = defaultDependencies,
): Promise<RoutePageDetail> {
  const groups = await dependencies.getRouteStopGroups(env, query.city, query.routeName, query.routeUid)

  try {
    const detail = await dependencies.getRouteDetail(env, query)
    if (detail.stops.some((stop) => stop.etaLabel !== null)) {
      return { detail, eta: { kind: 'realtime' } }
    }
    return {
      detail: withSelectedStopStatus(detail, '暫無即時'),
      eta: { kind: 'empty' },
    }
  } catch (error) {
    if (isRejectedUserTdxToken(error, env.TDX_USER_ACCESS_TOKEN)) throw error

    const warning = tdxWarningFromError(error)
    if (!warning) throw error

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
      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : null,
      etaTone: 'muted',
    })),
  }
}

function withSelectedStopStatus(detail: RouteDetail, selectedStatus: string): RouteDetail {
  return {
    ...detail,
    stops: detail.stops.map((stop) => stop.selected
      ? { ...stop, etaLabel: selectedStatus, etaTone: 'muted' }
      : stop),
  }
}

function unavailableLabel(warning: TDXWarning): string {
  if (warning === 'tdx-quota') return '額度不可用'
  if (warning === 'tdx-rate-limit') return '即時忙線'
  return '即時未更新'
}
