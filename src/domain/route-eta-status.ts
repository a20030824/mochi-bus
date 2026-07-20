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

export type RouteEtaPresentationState = {
  source: RouteEtaSource
  status: RouteEtaStatus
}

export type RouteEtaTdxInput = {
  hasRealtimeRecord: boolean
  estimateSeconds: number | null
  stopStatus?: number
}

const TDX_STOP_STATUS: Record<number, RouteEtaStatus> = {
  0: 'no-estimate',
  1: 'not-departed',
  2: 'not-stopping',
  3: 'last-bus-passed',
  4: 'not-operating',
}

/** Build Route control state directly from TDX data, before formatting labels. */
export function routeEtaStateFromTdx(input: RouteEtaTdxInput): RouteEtaPresentationState {
  if (!input.hasRealtimeRecord) return { source: 'none', status: 'missing' }
  if (input.estimateSeconds !== null) return { source: 'realtime', status: 'estimated' }
  return {
    source: 'realtime',
    status: TDX_STOP_STATUS[input.stopStatus ?? 0] ?? 'unknown',
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
