export type ScheduleTimetable = {
  ServiceDay?: Record<string, number>
  StopTimes?: Array<{
    StopUID?: string
    ArrivalTime?: string
    DepartureTime?: string
  }>
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

// 即時 GPS 沒有預估時間時(尚未發車／資料中斷)的備援:算出時刻表上下一班還要幾分鐘。
export function nextScheduledMinutes(schedules: ScheduleItem[], query: ScheduleQuery, now: Date): number | null {
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

  const candidates = matched
    .flatMap((schedule) => schedule.Timetables ?? [])
    .filter((timetable) => timetable.ServiceDay?.[weekday] === 1)
    .flatMap((timetable) => timetable.StopTimes ?? [])
    .filter((stop) => stop.StopUID === query.stopUid)
    .map((stop) => timeToMinutes(stop.ArrivalTime ?? stop.DepartureTime))
    .filter((value): value is number => value !== null && value >= nowMinutes)
    .map((value) => value - nowMinutes)

  return candidates.length ? Math.min(...candidates) : null
}

function timeToMinutes(value?: string): number | null {
  if (!value || !/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  return hour * 60 + minute
}
