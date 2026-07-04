export type ScheduleStopTime = {
  StopUID?: string
  StopSequence?: number
  ArrivalTime?: string
  DepartureTime?: string
}

export type ScheduleTimetable = {
  ServiceDay?: Record<string, number>
  StopTimes?: ScheduleStopTime[]
}

export type ScheduleItem = {
  SubRouteUID?: string
  Direction?: number
  Timetables?: ScheduleTimetable[]
}

export type ScheduleQuery = {
  stopUid: string
  direction: number
  subRouteUid?: string
}

export type ScheduleEstimate = {
  minutes: number
  // 有些縣市(如台南)的 TDX 時刻表每班次只提供起點發車時間;
  // true 代表 minutes 是「下一班還有幾分鐘發車」,不是到本站的時間。
  departureBased: boolean
}

// 即時 GPS 沒有預估時間時(尚未發車／資料中斷)的備援:算出時刻表上下一班還要幾分鐘。
export function nextScheduledMinutes(schedules: ScheduleItem[], query: ScheduleQuery, now: Date): ScheduleEstimate | null {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei', weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sunday'
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  const nowMinutes = hour * 60 + minute

  // 同方向可能有多條支線停同一站,必須看過全部符合的項目取最近一班,
  // 不能只取第一個符合的 schedule。
  const exactMatches = schedules.filter((item) =>
    (!query.subRouteUid || item.SubRouteUID === query.subRouteUid) && item.Direction === query.direction,
  )
  const matched = exactMatches.length ? exactMatches : schedules.filter((item) =>
    item.Direction === query.direction
    && item.Timetables?.some((timetable) => timetable.StopTimes?.some((stop) => stop.StopUID === query.stopUid)))

  const todaysTimetables = matched
    .flatMap((schedule) => schedule.Timetables ?? [])
    .filter((timetable) => timetable.ServiceDay?.[weekday] === 1)

  const atThisStop = upcomingMinutes(
    todaysTimetables.flatMap((timetable) => timetable.StopTimes ?? [])
      .filter((stop) => stop.StopUID === query.stopUid),
    nowMinutes,
  )
  if (atThisStop !== null) return { minutes: atThisStop, departureBased: false }

  // 本站沒有自己的時刻(資料只有起點發車時間、或今天本站班次已過):
  // 退回用每班次最早的一筆(起點)當發車時間下限估計。
  const departures = upcomingMinutes(
    todaysTimetables
      .map((timetable) => earliestStopTime(timetable))
      .filter((stop): stop is ScheduleStopTime => stop !== undefined),
    nowMinutes,
  )
  return departures === null ? null : { minutes: departures, departureBased: true }
}

function upcomingMinutes(stopTimes: ScheduleStopTime[], nowMinutes: number): number | null {
  const candidates = stopTimes
    .map((stop) => timeToMinutes(stop.ArrivalTime ?? stop.DepartureTime))
    .filter((value): value is number => value !== null && value >= nowMinutes)
    .map((value) => value - nowMinutes)
  return candidates.length ? Math.min(...candidates) : null
}

function earliestStopTime(timetable: ScheduleTimetable): ScheduleStopTime | undefined {
  return (timetable.StopTimes ?? [])
    .slice()
    .sort((a, b) => (a.StopSequence ?? 0) - (b.StopSequence ?? 0))[0]
}

function timeToMinutes(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}
