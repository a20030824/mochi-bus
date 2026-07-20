import { describe, expect, it } from 'vitest'
import type { ScheduleItem } from './schedule'
import {
  applyRouteTimelineFallback,
  ROUTE_UNKNOWN_ETA_LABEL,
  routeTimelineNeedsSchedule,
} from './route-timeline-fallback'

const now = new Date('2026-07-20T05:20:00.000Z') // Monday 13:20 in Taipei
const query = { direction: 0, subRouteUid: 'TPE307-0' }

const stops = [
  { stopUid: 'TPE1', etaLabel: '12 分', etaTone: 'live' as const },
  { stopUid: 'TPE2', etaLabel: '尚未發車', etaTone: 'muted' as const },
  { stopUid: 'TPE3', etaLabel: null, etaTone: 'muted' as const },
]

function timetable(stopUid: string, time: string): ScheduleItem[] {
  return [{
    SubRouteUID: 'TPE307-0',
    Direction: 0,
    Timetables: [{
      ServiceDay: { Monday: 1 },
      StopTimes: [{ StopUID: stopUid, StopSequence: 2, ArrivalTime: time }],
    }],
  }]
}

describe('Route timeline timetable fallback', () => {
  it('marks a timeline as schedule-eligible only when muted ETA is missing or provisional', () => {
    expect(routeTimelineNeedsSchedule(stops)).toBe(true)
    expect(routeTimelineNeedsSchedule([
      { stopUid: 'TPE1', etaLabel: '12 分', etaTone: 'live' },
      { stopUid: 'TPE2', etaLabel: '末班車已過', etaTone: 'muted' },
    ])).toBe(false)
  })

  it('fills only exact stop-level timetable arrivals and keeps realtime rows untouched', () => {
    const result = applyRouteTimelineFallback(stops, timetable('TPE3', '13:45'), query, now)

    expect(result[0]).toEqual(stops[0])
    expect(result[1]).toMatchObject({ etaLabel: '尚未發車', etaTone: 'muted' })
    expect(result[2]).toMatchObject({ etaLabel: '表定 13:45', etaTone: 'muted' })
  })

  it('does not present origin-only departure data as a stop arrival', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Monday: 1 },
        StopTimes: [{ StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '13:30' }],
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)

    expect(result[1].etaLabel).toBe('尚未發車')
    expect(result[2].etaLabel).toBe(ROUTE_UNKNOWN_ETA_LABEL)
  })

  it('does not present route-level headway as a station arrival', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Frequencys: [{
        ServiceDay: { Monday: 1 },
        StartTime: '13:00',
        EndTime: '14:00',
        MinHeadwayMins: 8,
        MaxHeadwayMins: 12,
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)

    expect(result[2].etaLabel).toBe(ROUTE_UNKNOWN_ETA_LABEL)
  })

  it('labels tomorrow stop-level times without turning them into relative ETA', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Tuesday: 1 },
        StopTimes: [{ StopUID: 'TPE3', StopSequence: 3, ArrivalTime: '06:10' }],
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)

    expect(result[2].etaLabel).toBe('表定 明日 06:10')
  })

  it('labels after-midnight times from the current service day as tomorrow', () => {
    const lateNow = new Date('2026-07-20T15:50:00.000Z') // Monday 23:50 in Taipei
    const result = applyRouteTimelineFallback(stops, timetable('TPE3', '24:20'), query, lateNow)

    expect(result[2].etaLabel).toBe('表定 明日 00:20')
  })

  it('preserves explicit non-service statuses instead of replacing them with a dash', () => {
    const result = applyRouteTimelineFallback([
      { stopUid: 'TPE1', etaLabel: '交管不停靠', etaTone: 'muted' as const },
      { stopUid: 'TPE2', etaLabel: '末班車已過', etaTone: 'muted' as const },
      { stopUid: 'TPE3', etaLabel: '今日未營運', etaTone: 'muted' as const },
    ], [], query, now)

    expect(result.map((stop) => stop.etaLabel)).toEqual(['交管不停靠', '末班車已過', '今日未營運'])
  })
})
