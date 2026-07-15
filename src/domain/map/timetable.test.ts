import { describe, expect, it } from 'vitest'
import { buildRouteTimetable } from './timetable'
import type { ScheduleItem } from '../schedule'

const stops = [
  { stopUid: 'C1', stopName: '嘉義公園', sequence: 1 },
  { stopUid: 'C2', stopName: '嘉義火車站', sequence: 2 },
  { stopUid: 'C3', stopName: '朴子轉運站', sequence: 3 },
]
const weekday = { Monday: 1, Tuesday: 1, Wednesday: 1, Thursday: 1, Friday: 1 }

describe('buildRouteTimetable', () => {
  it('builds a selectable per-stop timetable when multiple stops have times', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'CHI-7211', Direction: 0, Timetables: [
        { ServiceDay: weekday, StopTimes: [
          { StopUID: 'C1', StopSequence: 1, DepartureTime: '06:00' },
          { StopUID: 'C2', StopSequence: 2, ArrivalTime: '06:12' },
          { StopUID: 'C3', StopSequence: 3, ArrivalTime: '07:00' },
        ] },
        { ServiceDay: weekday, StopTimes: [
          { StopUID: 'C1', StopSequence: 1, DepartureTime: '07:00' },
          { StopUID: 'C2', StopSequence: 2, ArrivalTime: '07:12' },
          { StopUID: 'C3', StopSequence: 3, ArrivalTime: '08:00' },
        ] },
      ],
    }]
    const result = buildRouteTimetable(schedules, { direction: 0, subRouteUid: 'CHI-7211', stops }, 'C2', new Date('2026-07-13T02:00:00Z'))
    expect(result.mode).toBe('stop')
    expect(result.timedStopCount).toBe(3)
    expect(result.selectedStop?.stopName).toBe('嘉義火車站')
    expect(result.services[0]).toMatchObject({ label: '平日', today: true, times: ['06:12', '07:12'] })
  })

  it('labels a single-stop schedule as departure-only instead of pretending every stop has times', () => {
    const schedules: ScheduleItem[] = [{ Direction: 0, Timetables: [
      { ServiceDay: weekday, StopTimes: [{ StopUID: 'C1', StopSequence: 1, DepartureTime: '06:00' }] },
      { ServiceDay: weekday, StopTimes: [{ StopUID: 'C1', StopSequence: 1, DepartureTime: '07:00' }] },
    ] }]
    const result = buildRouteTimetable(schedules, { direction: 0, stops }, 'C2', new Date('2026-07-13T02:00:00Z'))
    expect(result.mode).toBe('departure')
    expect(result.selectedStop?.stopUid).toBe('C2')
    expect(result.departureStop?.stopUid).toBe('C1')
    expect(result.services[0].times).toEqual(['06:00', '07:00'])
  })

  it('normalizes frequency windows when no fixed departures exist', () => {
    const schedules: ScheduleItem[] = [{ Direction: 1, Frequencys: [{
      ServiceDay: weekday, StartTime: '06:00', EndTime: '09:00', MinHeadwayMins: 10, MaxHeadwayMins: 15,
    }] }]
    const result = buildRouteTimetable(schedules, { direction: 1, stops }, undefined, new Date('2026-07-13T02:00:00Z'))
    expect(result.mode).toBe('frequency')
    expect(result.services[0]).toMatchObject({
      firstTime: '06:00', lastTime: '09:00',
      periods: [{ startTime: '06:00', endTime: '09:00', minHeadwayMinutes: 10, maxHeadwayMinutes: 15 }],
    })
  })

  it('prefers the selected subroute over another schedule in the same direction', () => {
    const schedules: ScheduleItem[] = [
      { SubRouteUID: 'A', Direction: 0, Timetables: [{ ServiceDay: weekday, StopTimes: [{ StopUID: 'C1', StopSequence: 1, DepartureTime: '06:00' }] }] },
      { SubRouteUID: 'B', Direction: 0, Timetables: [{ ServiceDay: weekday, StopTimes: [{ StopUID: 'C1', StopSequence: 1, DepartureTime: '09:00' }] }] },
    ]
    const result = buildRouteTimetable(schedules, { direction: 0, subRouteUid: 'B', stops }, undefined, new Date('2026-07-13T02:00:00Z'))
    expect(result.services[0].times).toEqual(['09:00'])
  })
})
