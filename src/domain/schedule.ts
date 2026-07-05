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

// 班距制(雙北常見):某時段內每 N–M 分一班,沒有逐班時刻。
export type ScheduleFrequency = {
  StartTime?: string
  EndTime?: string
  MinHeadwayMins?: number
  MaxHeadwayMins?: number
  ServiceDay?: Record<string, number>
}

export type ScheduleItem = {
  SubRouteUID?: string
  Direction?: number
  Timetables?: ScheduleTimetable[]
  Frequencys?: ScheduleFrequency[]
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
  // 班距制時段進行中:顯示端應呈現「N–M 分一班」;minutes 是保守估計(最大班距)。
  headwayMinutes?: [number, number]
}

// 超過一小時的「還有 N 分」沒人心算得動(深夜查首班車會看到 200+ 分),直接給時刻;
// 一小時內維持相對時間。班距制不適用(minutes 是班距估計,不是特定班次)。
export function scheduleClockLabel(estimate: ScheduleEstimate, now: Date): string | null {
  if (estimate.headwayMinutes || estimate.minutes <= 60) return null
  const clock = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(now.getTime() + estimate.minutes * 60_000))
  return `${clock} ${estimate.departureBased ? '發車' : '到站'}`
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
  if (departures !== null) return { minutes: departures, departureBased: true }

  // 班距制(雙北):時段進行中用最大班距當保守估計;時段還沒開始就等到開始。
  const todaysFrequencies = matched
    .flatMap((schedule) => schedule.Frequencys ?? [])
    .filter((frequency) => frequency.ServiceDay?.[weekday] === 1)
  const active = todaysFrequencies
    .filter((frequency) => {
      const start = timeToMinutes(frequency.StartTime)
      const end = timeToMinutes(frequency.EndTime)
      return start !== null && end !== null && start <= nowMinutes && nowMinutes <= end
    })
    .sort((a, b) => (a.MaxHeadwayMins ?? Infinity) - (b.MaxHeadwayMins ?? Infinity))[0]
  if (active && typeof active.MaxHeadwayMins === 'number') {
    return {
      minutes: active.MaxHeadwayMins,
      departureBased: true,
      headwayMinutes: [active.MinHeadwayMins ?? active.MaxHeadwayMins, active.MaxHeadwayMins],
    }
  }
  const nextWindowStarts = todaysFrequencies
    .map((frequency) => timeToMinutes(frequency.StartTime))
    .filter((start): start is number => start !== null && start >= nowMinutes)
  if (nextWindowStarts.length) {
    return { minutes: Math.min(...nextWindowStarts) - nowMinutes, departureBased: true }
  }
  return null
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
