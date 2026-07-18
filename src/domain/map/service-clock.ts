const DAY_KEYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

// TDX 時刻可用 24:xx 表示跨午夜班次；凌晨四點前仍視為前一服務日。
export const SERVICE_DAY_CUTOFF_HOUR = 4

export type ServiceClock = {
  dayIndex: number
  minutes: number
}

export function taipeiServiceClock(now = new Date()): ServiceClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const weekday = parts.find((part) => part.type === 'weekday')?.value
  const calendarDayIndex = DAY_KEYS.indexOf(weekday as typeof DAY_KEYS[number])
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0)
  const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? 0)
  const afterMidnightService = hour < SERVICE_DAY_CUTOFF_HOUR
  return {
    dayIndex: afterMidnightService
      ? ((calendarDayIndex < 0 ? 0 : calendarDayIndex) + 6) % 7
      : calendarDayIndex < 0 ? 0 : calendarDayIndex,
    minutes: (afterMidnightService ? hour + 24 : hour) * 60 + minute,
  }
}

export function timetableMinutes(value: string): number | null {
  if (!/^\d{2}:\d{2}$/.test(value)) return null
  const [hour, minute] = value.split(':').map(Number)
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour > 47 || minute > 59) return null
  return hour * 60 + minute
}
