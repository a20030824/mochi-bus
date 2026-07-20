import type {
  ScheduleFrequency,
  ScheduleItem,
  ScheduleStopTime,
} from './schedule'

export type RouteScheduleArrival = {
  minutes: number
  nextDay?: boolean
}

export type RouteScheduleArrivalQuery = {
  direction: number
  subRouteUid?: string
  stopUids: Iterable<string>
}

type IndexedSchedule = {
  item: ScheduleItem
  relevantStopUids: ReadonlySet<string>
}

type ServiceDayState = {
  arrivals: Map<string, number>
  blockedFromTomorrow: Set<string>
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/**
 * Build the exact stop-level timetable fallback for a Route timeline in one scan.
 *
 * This deliberately preserves nextScheduledMinutes() precedence: an available
 * origin-departure or frequency estimate today is not rendered as a station
 * arrival, but it still prevents the Route page from skipping ahead to a
 * tomorrow stop time.
 */
export function buildRouteScheduleArrivalIndex(
  schedules: readonly ScheduleItem[],
  query: RouteScheduleArrivalQuery,
  now: Date,
): Map<string, RouteScheduleArrival> {
  const targetStopUids = new Set(query.stopUids)
  const result = new Map<string, RouteScheduleArrival>()
  if (targetStopUids.size === 0) return result

  const { weekday, tomorrowWeekday, nowMinutes } = taipeiScheduleClock(now)
  const exactMatches = schedules.filter((item) =>
    item.Direction === query.direction
    && (!query.subRouteUid || !item.SubRouteUID || item.SubRouteUID === query.subRouteUid),
  )
  const useExactMatches = exactMatches.length > 0
  const candidates = useExactMatches
    ? exactMatches
    : schedules.filter((item) => item.Direction === query.direction)
  const indexedSchedules = candidates
    .map((item): IndexedSchedule => ({
      item,
      relevantStopUids: useExactMatches
        ? targetStopUids
        : fallbackRelevantStopUids(item, targetStopUids),
    }))
    .filter(({ relevantStopUids }) => relevantStopUids.size > 0)

  const today = collectServiceDay(
    indexedSchedules,
    targetStopUids,
    weekday,
    nowMinutes,
    true,
  )
  const unresolved = new Set<string>()
  for (const stopUid of targetStopUids) {
    const minutes = today.arrivals.get(stopUid)
    if (minutes !== undefined) {
      result.set(stopUid, { minutes })
    } else if (!today.blockedFromTomorrow.has(stopUid)) {
      unresolved.add(stopUid)
    }
  }
  if (unresolved.size === 0) return result

  const tomorrow = collectServiceDay(
    indexedSchedules,
    unresolved,
    tomorrowWeekday,
    nowMinutes - 24 * 60,
    false,
  )
  for (const stopUid of unresolved) {
    const minutes = tomorrow.arrivals.get(stopUid)
    if (minutes !== undefined) result.set(stopUid, { minutes, nextDay: true })
  }
  return result
}

function fallbackRelevantStopUids(
  item: ScheduleItem,
  targetStopUids: ReadonlySet<string>,
): Set<string> {
  if (item.Frequencys?.length) return new Set(targetStopUids)

  const relevant = new Set<string>()
  for (const timetable of item.Timetables ?? []) {
    for (const stop of timetable.StopTimes ?? []) {
      if (stop.StopUID && targetStopUids.has(stop.StopUID)) relevant.add(stop.StopUID)
    }
  }
  return relevant
}

function collectServiceDay(
  indexedSchedules: readonly IndexedSchedule[],
  eligibleStopUids: ReadonlySet<string>,
  weekday: string,
  nowMinutes: number,
  trackFallbackBlockers: boolean,
): ServiceDayState {
  const arrivals = new Map<string, number>()
  const blockedFromTomorrow = new Set<string>()

  for (const { item, relevantStopUids } of indexedSchedules) {
    const timetables = (item.Timetables ?? [])
      .filter((timetable) => timetable.ServiceDay?.[weekday] === 1)
    let hasUpcomingDeparture = false

    for (const timetable of timetables) {
      const stopTimes = timetable.StopTimes ?? []
      let earliestStop: ScheduleStopTime | undefined
      let earliestSequence = Infinity

      for (const stop of stopTimes) {
        const sequence = stop.StopSequence ?? 0
        if (!earliestStop || sequence < earliestSequence) {
          earliestStop = stop
          earliestSequence = sequence
        }

        const stopUid = stop.StopUID
        if (!stopUid || !eligibleStopUids.has(stopUid) || !relevantStopUids.has(stopUid)) continue
        const scheduledMinutes = timeToMinutes(stop.ArrivalTime ?? stop.DepartureTime)
        if (scheduledMinutes === null || scheduledMinutes < nowMinutes) continue
        recordMinimum(arrivals, stopUid, scheduledMinutes - nowMinutes)
      }

      if (trackFallbackBlockers && earliestStop) {
        const departure = timeToMinutes(earliestStop.ArrivalTime ?? earliestStop.DepartureTime)
        if (departure !== null && departure >= nowMinutes) hasUpcomingDeparture = true
      }
    }

    if (!trackFallbackBlockers) continue
    const blocksTomorrow = hasUpcomingDeparture
      || hasFrequencyEstimate(item.Frequencys ?? [], weekday, nowMinutes)
    if (!blocksTomorrow) continue
    for (const stopUid of relevantStopUids) {
      if (eligibleStopUids.has(stopUid)) blockedFromTomorrow.add(stopUid)
    }
  }

  return { arrivals, blockedFromTomorrow }
}

function hasFrequencyEstimate(
  frequencies: readonly ScheduleFrequency[],
  weekday: string,
  nowMinutes: number,
): boolean {
  const activeFrequencies = frequencies.filter((frequency) => frequency.ServiceDay?.[weekday] === 1)
  const active = activeFrequencies.some((frequency) => {
    const start = timeToMinutes(frequency.StartTime)
    const end = timeToMinutes(frequency.EndTime)
    return start !== null
      && end !== null
      && start <= nowMinutes
      && nowMinutes <= end
      && typeof frequency.MaxHeadwayMins === 'number'
  })
  if (active) return true
  return activeFrequencies.some((frequency) => {
    const start = timeToMinutes(frequency.StartTime)
    return start !== null && start >= nowMinutes
  })
}

function recordMinimum(target: Map<string, number>, key: string, value: number): void {
  const current = target.get(key)
  if (current === undefined || value < current) target.set(key, value)
}

function taipeiScheduleClock(now: Date): {
  weekday: string
  tomorrowWeekday: string
  nowMinutes: number
} {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sunday'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  return {
    weekday,
    tomorrowWeekday: WEEKDAYS[(WEEKDAYS.indexOf(weekday) + 1) % 7],
    nowMinutes: hour * 60 + minute,
  }
}

function timeToMinutes(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}
