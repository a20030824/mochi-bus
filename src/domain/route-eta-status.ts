import type { RouteDetail } from '../lib/tdx'

export type RouteEtaSource = 'realtime' | 'schedule' | 'none'

export type RouteEtaStatus =
  | 'estimated'
  | 'missing'
  | 'no-estimate'
  | 'not-departed'
  | 'not-stopping'
  | 'last-bus-passed'
  | 'not-operating'
  | 'unknown'
  | 'pending'
  | 'unavailable'

export type RouteEtaPresentationState = {
  source: RouteEtaSource
  status: RouteEtaStatus
}

type RouteEtaStop = RouteDetail['stops'][number]

/**
 * Decode the legacy RouteDetail presentation once at the domain boundary.
 * Downstream fallback behavior consumes the typed state and never compares
 * user-facing wording. The browser API remains unchanged.
 */
export function routeEtaStatesFromStops(
  stops: readonly RouteEtaStop[],
): RouteEtaPresentationState[] {
  return stops.map(routeEtaStateFromStop)
}

export function routeEtaStateFromStop(stop: RouteEtaStop): RouteEtaPresentationState {
  if (stop.etaTone === 'live' || stop.etaTone === 'urgent') {
    return { source: 'realtime', status: 'estimated' }
  }
  if (stop.etaLabel === null || stop.etaLabel === '—') {
    return { source: 'none', status: 'missing' }
  }

  const status = ({
    '暫無預估時間': 'no-estimate',
    '尚未發車': 'not-departed',
    '交管不停靠': 'not-stopping',
    '末班車已過': 'last-bus-passed',
    '今日未營運': 'not-operating',
    '更新中': 'pending',
    '暫無即時': 'unavailable',
    '即時忙線': 'unavailable',
    '額度不可用': 'unavailable',
    '即時未更新': 'unavailable',
  } as Record<string, RouteEtaStatus>)[stop.etaLabel] ?? 'unknown'

  return {
    source: status === 'pending' || status === 'unavailable' ? 'none' : 'realtime',
    status,
  }
}

export function routeEtaCanUseSchedule(state: RouteEtaPresentationState): boolean {
  return state.status === 'missing'
    || state.status === 'no-estimate'
    || state.status === 'not-departed'
}

export function routeEtaHasRealtimeEstimate(state: RouteEtaPresentationState): boolean {
  return state.source === 'realtime' && state.status === 'estimated'
}

export function routeEtaIsUnknown(state: RouteEtaPresentationState): boolean {
  return state.status === 'missing' || state.status === 'no-estimate'
}
