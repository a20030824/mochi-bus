import { describe, expect, it } from 'vitest'
import type { RouteTimetable } from './map-api-client'
import { timetableSummaryText } from './timetable-view'

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
