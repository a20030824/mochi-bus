import { buildRouteScheduleArrivalIndex } from './route-schedule-arrival-index'
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

export function routeTimelineNeedsSchedule(
  stops: readonly RouteTimelineStopPresentation[],
): boolean {
  return stops.some(isScheduleEligible)
}

export function applyRouteTimelineFallback<T extends RouteTimelineStopPresentation>(
  stops: readonly T[],
  schedules: ScheduleItem[],
  query: RouteTimelineScheduleQuery,
  now: Date,
): T[] {
  const scheduledArrivals = buildRouteScheduleArrivalIndex(schedules, {
    direction: query.direction,
    subRouteUid: query.subRouteUid,
    stopUids: stops.filter(isScheduleEligible).map((stop) => stop.stopUid),
  }, now)

  return stops.map((stop) => {
    if (!isScheduleEligible(stop)) return stop

    const estimate = scheduledArrivals.get(stop.stopUid)
    const scheduledLabel = estimate
      ? routeScheduledClockLabel(estimate.minutes, Boolean(estimate.nextDay), now)
      : null

    if (scheduledLabel) {
      return { ...stop, etaLabel: scheduledLabel, etaTone: 'muted' } as T
    }

    return {
      ...stop,
      etaLabel: stop.etaLabel === '尚未發車' ? stop.etaLabel : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    } as T
  })
}

function isScheduleEligible(stop: RouteTimelineStopPresentation): boolean {
  if (stop.etaTone !== 'muted') return false
  return stop.etaLabel === null
    || stop.etaLabel === '暫無預估時間'
    || stop.etaLabel === '尚未發車'
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
