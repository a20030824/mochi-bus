import { buildRouteScheduleArrivalIndex } from './route-schedule-arrival-index'
import {
  routeEtaCanUseSchedule,
  type RouteEtaPresentationState,
} from './route-eta-status'
import type { ScheduleItem } from './schedule'

export const ROUTE_UNKNOWN_ETA_LABEL = '—'

export type RouteTimelineStopPresentation = {
  stopUid: string
  etaLabel: string | null
  etaTone: 'live' | 'urgent' | 'muted'
}

export type RouteTimelineScheduleQuery = {
  direction: number
  subRouteUid?: string
}

export type RouteTimelineFallbackResult<T extends RouteTimelineStopPresentation> = {
  stops: T[]
  states: RouteEtaPresentationState[]
}

export function routeTimelineNeedsSchedule(
  stops: readonly RouteTimelineStopPresentation[],
  states: readonly RouteEtaPresentationState[],
): boolean {
  assertParallelStates(stops, states)
  return stops.some((stop, index) => isScheduleEligible(stop, states[index]))
}

export function applyRouteTimelineFallback<T extends RouteTimelineStopPresentation>(
  stops: readonly T[],
  states: readonly RouteEtaPresentationState[],
  schedules: ScheduleItem[],
  query: RouteTimelineScheduleQuery,
  now: Date,
): RouteTimelineFallbackResult<T> {
  assertParallelStates(stops, states)
  const scheduledArrivals = buildRouteScheduleArrivalIndex(schedules, {
    direction: query.direction,
    subRouteUid: query.subRouteUid,
    stopUids: stops
      .filter((stop, index) => isScheduleEligible(stop, states[index]))
      .map((stop) => stop.stopUid),
  }, now)
  const nextStates = [...states]

  const nextStops = stops.map((stop, index) => {
    const state = states[index]
    if (!isScheduleEligible(stop, state)) return stop

    const estimate = scheduledArrivals.get(stop.stopUid)
    const scheduledLabel = estimate
      ? routeScheduledClockLabel(estimate.minutes, Boolean(estimate.nextDay), now)
      : null

    if (scheduledLabel) {
      nextStates[index] = { source: 'schedule', status: 'estimated' }
      return { ...stop, etaLabel: scheduledLabel, etaTone: 'muted' } as T
    }

    return {
      ...stop,
      etaLabel: state.status === 'not-departed' ? stop.etaLabel : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    } as T
  })

  return { stops: nextStops, states: nextStates }
}

function isScheduleEligible(
  stop: RouteTimelineStopPresentation,
  state: RouteEtaPresentationState,
): boolean {
  return stop.etaTone === 'muted' && routeEtaCanUseSchedule(state)
}

function assertParallelStates(
  stops: readonly RouteTimelineStopPresentation[],
  states: readonly RouteEtaPresentationState[],
): void {
  if (stops.length !== states.length) {
    throw new Error('Route ETA presentation state does not match the station timeline')
  }
}

function routeScheduledClockLabel(minutes: number, nextDay: boolean, now: Date): string {
  const arrival = new Date(now.getTime() + minutes * 60_000)
  const clock = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(arrival)
  const crossesTaipeiDate = taipeiDateKey(arrival) !== taipeiDateKey(now)
  return `表定 ${nextDay || crossesTaipeiDate ? '明日 ' : ''}${clock}`
}

function taipeiDateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}
