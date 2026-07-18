import { describe, expect, it } from 'vitest'
import { taipeiServiceClock, timetableMinutes } from './service-clock'

describe('Taipei service clock', () => {
  it('keeps early-morning trips on the previous service day', () => {
    expect(taipeiServiceClock(new Date('2026-07-13T17:30:00Z'))).toEqual({
      dayIndex: 1,
      minutes: 25 * 60 + 30,
    })
  })

  it('starts the calendar service day at the cutoff', () => {
    expect(taipeiServiceClock(new Date('2026-07-13T20:00:00Z'))).toEqual({
      dayIndex: 2,
      minutes: 4 * 60,
    })
  })

  it('normalizes TDX extended-hour timetable values', () => {
    expect(timetableMinutes('25:30')).toBe(25 * 60 + 30)
    expect(timetableMinutes('48:00')).toBeNull()
    expect(timetableMinutes('09:60')).toBeNull()
  })
})
