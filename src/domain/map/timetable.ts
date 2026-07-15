import type { Direction } from '../bus-query'
import type { ScheduleFrequency, ScheduleItem, ScheduleStopTime, ScheduleTimetable } from '../schedule'

const DAY_KEYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const
const DAY_LABELS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'] as const

export type TimetableStop = {
  stopUid: string
  stopName: string
  sequence: number
  hasTimes: boolean
}

export type TimetablePeriod = {
  startTime: string
  endTime: string
  minHeadwayMinutes: number
  maxHeadwayMinutes: number
}

export type TimetableService = {
  id: string
  label: string
  days: number[]
  today: boolean
  times: string[]
  periods: TimetablePeriod[]
  firstTime: string | null
  lastTime: string | null
}

export type RouteTimetable = {
  mode: 'stop' | 'departure' | 'frequency' | 'none'
  selectedStop: Omit<TimetableStop, 'hasTimes'> | null
  departureStop: Omit<TimetableStop, 'hasTimes'> | null
  stops: TimetableStop[]
  timedStopCount: number
  services: TimetableService[]
}

export type TimetableVariant = {
  direction: Direction
  subRouteUid?: string
  stops: Array<{ stopUid: string; stopName: string; sequence: number }>
}

type ServiceBuilder = {
  days: number[]
  times: Set<string>
  periods: Map<string, TimetablePeriod>
}

export function buildRouteTimetable(
  schedules: ScheduleItem[],
  variant: TimetableVariant,
  requestedStopUid?: string,
  now = new Date(),
): RouteTimetable {
  const stops = variant.stops.slice().sort((a, b) => a.sequence - b.sequence)
  const directionMatches = schedules.filter((item) => item.Direction === variant.direction)
  const exactMatches = directionMatches.filter((item) =>
    !variant.subRouteUid || !item.SubRouteUID || item.SubRouteUID === variant.subRouteUid)
  const matched = exactMatches.some(hasScheduleData) ? exactMatches : directionMatches

  const timedStops = new Set(stops
    .filter((stop) => matched.some((item) => item.Timetables?.some((table) => timesForStop(table, stop).length)))
    .map((stop) => stop.stopUid))
  const stopModels = stops.map((stop) => ({ ...stop, hasTimes: timedStops.has(stop.stopUid) }))
  const selected = stops.find((stop) => stop.stopUid === requestedStopUid) ?? stops[0] ?? null
  const hasSelectedTimes = selected
    ? matched.some((item) => item.Timetables?.some((table) => timesForStop(table, selected).length))
    : false
  const hasAnyTimes = matched.some((item) => item.Timetables?.some((table) => Boolean(earliestTime(table))))
  const hasFrequency = matched.some((item) => item.Frequencys?.some(validFrequency))
  const mode: RouteTimetable['mode'] = timedStops.size >= 2 && hasSelectedTimes
    ? 'stop'
    : hasAnyTimes
      ? 'departure'
      : hasFrequency ? 'frequency' : 'none'

  const builders = new Map<string, ServiceBuilder>()
  const ensureBuilder = (serviceDay?: Record<string, number>) => {
    const days = serviceDays(serviceDay)
    const id = days.length ? days.join('-') : 'unspecified'
    let builder = builders.get(id)
    if (!builder) {
      builder = { days, times: new Set(), periods: new Map() }
      builders.set(id, builder)
    }
    return builder
  }

  for (const item of matched) {
    if (mode === 'stop' || mode === 'departure') {
      for (const table of item.Timetables ?? []) {
        const builder = ensureBuilder(table.ServiceDay)
        const values = mode === 'stop' && selected
          ? timesForStop(table, selected)
          : [earliestTime(table)].filter((value): value is string => Boolean(value))
        values.forEach((value) => builder.times.add(value))
      }
    }
    if (mode === 'frequency') {
      for (const frequency of item.Frequencys ?? []) {
        const period = normalizeFrequency(frequency)
        if (!period) continue
        const builder = ensureBuilder(frequency.ServiceDay)
        builder.periods.set(`${period.startTime}-${period.endTime}-${period.minHeadwayMinutes}-${period.maxHeadwayMinutes}`, period)
      }
    }
  }

  const todayIndex = taipeiDayIndex(now)
  const services = [...builders.entries()].map(([id, builder]): TimetableService => {
    const times = [...builder.times].sort(compareTimes)
    const periods = [...builder.periods.values()].sort((a, b) => compareTimes(a.startTime, b.startTime))
    return {
      id,
      label: serviceDayLabel(builder.days),
      days: builder.days,
      today: builder.days.includes(todayIndex),
      times,
      periods,
      firstTime: times[0] ?? periods[0]?.startTime ?? null,
      lastTime: times.at(-1) ?? periods.at(-1)?.endTime ?? null,
    }
  }).filter((service) => service.times.length || service.periods.length)
    .sort((a, b) => Number(b.today) - Number(a.today) || (a.days[0] ?? 8) - (b.days[0] ?? 8))

  const departure = stops[0] ?? null
  return {
    mode,
    selectedStop: selected ? stripHasTimes(selected) : null,
    departureStop: departure ? stripHasTimes(departure) : null,
    stops: stopModels,
    timedStopCount: timedStops.size,
    services,
  }
}

function hasScheduleData(item: ScheduleItem): boolean {
  return Boolean(item.Timetables?.some((table) => Boolean(earliestTime(table)))
    || item.Frequencys?.some(validFrequency))
}

function stripHasTimes(stop: { stopUid: string; stopName: string; sequence: number }) {
  return { stopUid: stop.stopUid, stopName: stop.stopName, sequence: stop.sequence }
}

function timeValue(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || minute > 59) return null
  return hour * 60 + minute
}

function compareTimes(a: string, b: string): number {
  return (timeValue(a) ?? Number.POSITIVE_INFINITY) - (timeValue(b) ?? Number.POSITIVE_INFINITY)
}

function stopTimeValue(stop: ScheduleStopTime): string | null {
  const value = stop.ArrivalTime ?? stop.DepartureTime
  return timeValue(value) === null ? null : value ?? null
}

function timesForStop(table: ScheduleTimetable, stop: TimetableVariant['stops'][number]): string[] {
  return (table.StopTimes ?? [])
    .filter((candidate) => candidate.StopUID === stop.stopUid
      || (!candidate.StopUID && candidate.StopSequence === stop.sequence))
    .map(stopTimeValue)
    .filter((value): value is string => Boolean(value))
}

function earliestTime(table: ScheduleTimetable): string | null {
  return (table.StopTimes ?? [])
    .map((stop) => ({ stop, value: stopTimeValue(stop) }))
    .filter((entry): entry is { stop: ScheduleStopTime; value: string } => Boolean(entry.value))
    .sort((a, b) => (a.stop.StopSequence ?? Number.POSITIVE_INFINITY) - (b.stop.StopSequence ?? Number.POSITIVE_INFINITY))[0]?.value ?? null
}

function validFrequency(frequency: ScheduleFrequency): boolean {
  return normalizeFrequency(frequency) !== null
}

function normalizeFrequency(frequency: ScheduleFrequency): TimetablePeriod | null {
  if (timeValue(frequency.StartTime) === null || timeValue(frequency.EndTime) === null) return null
  if (typeof frequency.MaxHeadwayMins !== 'number') return null
  return {
    startTime: frequency.StartTime!,
    endTime: frequency.EndTime!,
    minHeadwayMinutes: frequency.MinHeadwayMins ?? frequency.MaxHeadwayMins,
    maxHeadwayMinutes: frequency.MaxHeadwayMins,
  }
}

function serviceDays(serviceDay?: Record<string, number>): number[] {
  if (!serviceDay) return []
  return DAY_KEYS.flatMap((key, index) => serviceDay[key] === 1 ? [index] : [])
}

function serviceDayLabel(days: number[]): string {
  const signature = days.join(',')
  if (signature === '0,1,2,3,4,5,6') return '每日'
  if (signature === '1,2,3,4,5') return '平日'
  if (signature === '0,6') return '週末'
  if (signature === '6') return '週六'
  if (signature === '0') return '週日'
  return days.length ? days.map((day) => DAY_LABELS[day]).join('、') : '日期未標示'
}

function taipeiDayIndex(now: Date): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'long' }).format(now)
  const index = DAY_KEYS.indexOf(weekday as typeof DAY_KEYS[number])
  return index < 0 ? 0 : index
}
