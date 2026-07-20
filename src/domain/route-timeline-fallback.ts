import {
  nextScheduledMinutes,
  type ScheduleItem,
} from './schedule'

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
  return stops.map((stop) => {
    if (!isScheduleEligible(stop)) return stop

    const estimate = nextScheduledMinutes(schedules, {
      stopUid: stop.stopUid,
      direction: query.direction,
      subRouteUid: query.subRouteUid,
    }, now)
    const scheduledLabel = estimate && !estimate.departureBased && !estimate.headwayMinutes
      ? routeScheduledClockLabel(estimate.minutes, Boolean(estimate.nextDay), now)
      : null

    if (scheduledLabel) {
      return { ...stop, etaLabel: scheduledLabel, etaTone: 'muted' }
    }

    return {
      ...stop,
      etaLabel: stop.etaLabel === '尚未發車' ? stop.etaLabel : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    }
  })
}

function isScheduleEligible(stop: RouteTimelineStopPresentation): boolean {
  if (stop.etaTone !== 'muted') return false
  return stop.etaLabel === null
    || stop.etaLabel === '暫無預估時間'
    || stop.etaLabel === '尚未發車'
}

function routeScheduledClockLabel(minutes: number, nextDay: boolean, now: Date): string {
  const clock = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(now.getTime() + minutes * 60_000))
  return `表定 ${nextDay ? '明日 ' : ''}${clock}`
}
