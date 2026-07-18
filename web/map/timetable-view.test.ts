import { describe, expect, it } from 'vitest'
import type { RouteTimetable } from './map-api-client'
import { timetableSummaryText, timetableTimeStates } from './timetable-view'

const timetable = (overrides: Partial<RouteTimetable> = {}): RouteTimetable => ({
  mode: 'frequency',
  selectedStop: null,
  departureStop: null,
  stops: [],
  timedStopCount: 0,
  services: [{
    id: 'weekday', label: '平日', days: [1, 2, 3, 4, 5], today: true,
    times: [], firstTime: '06:00', lastTime: '22:00',
    periods: [{ startTime: '06:00', endTime: '22:00', minHeadwayMinutes: 10, maxHeadwayMinutes: 15 }],
  }],
  ...overrides,
})

describe('timetable summary', () => {
  it('summarizes frequency ranges without exposing rendering concerns', () => {
    expect(timetableSummaryText(timetable())).toBe('營運 06:00–22:00 · 10–15 分一班')
  })

  it('labels the next known service day when today has no service', () => {
    const value = timetable()
    value.services[0] = { ...value.services[0], today: false, label: '週六' }
    expect(timetableSummaryText(value)).toBe('下一服務日 週六 · 營運 06:00–22:00 · 10–15 分一班')
  })
})

describe('timetable time states', () => {
  it('marks past, next, and future departures using the service clock', () => {
    const states = timetableTimeStates({
      today: true,
      times: ['09:00', '09:30', '10:00'],
    }, new Date('2026-07-14T01:15:00Z'))

    expect([...states]).toEqual([
      ['09:00', 'past'],
      ['09:30', 'next'],
      ['10:00', 'future'],
    ])
  })

  it('keeps an extended-hour departure as next after midnight', () => {
    const states = timetableTimeStates({
      today: true,
      times: ['23:50', '24:10', '25:40'],
    }, new Date('2026-07-13T16:05:00Z'))

    expect([...states]).toEqual([
      ['23:50', 'past'],
      ['24:10', 'next'],
      ['25:40', 'future'],
    ])
  })

  it('does not call any departure past on a future service tab', () => {
    const states = timetableTimeStates({
      today: false,
      times: ['06:00', '07:00'],
    }, new Date('2026-07-14T12:00:00Z'))

    expect([...states.values()]).toEqual(['future', 'future'])
  })
})
