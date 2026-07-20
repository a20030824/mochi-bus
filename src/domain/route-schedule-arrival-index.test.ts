import { describe, expect, it } from 'vitest'
import type { ScheduleItem, ScheduleTimetable } from './schedule'
import { buildRouteScheduleArrivalIndex } from './route-schedule-arrival-index'

const mondayAt1320 = new Date('2026-07-20T05:20:00.000Z') // Monday 13:20 in Taipei

function timetableSchedule(
  stopTimes: NonNullable<ScheduleTimetable['StopTimes']>,
  options: { subRouteUid?: string; direction?: number; serviceDay?: Record<string, number> } = {},
): ScheduleItem {
  return {
    SubRouteUID: options.subRouteUid,
    Direction: options.direction ?? 0,
    Timetables: [{
      ServiceDay: options.serviceDay ?? { Monday: 1 },
      StopTimes: stopTimes,
    }],
  }
}

describe('buildRouteScheduleArrivalIndex', () => {
  it('indexes the nearest exact time for every requested stop', () => {
    const index = buildRouteScheduleArrivalIndex([
      timetableSchedule([
        { StopUID: 'TPE1', StopSequence: 1, ArrivalTime: '13:10' },
        { StopUID: 'TPE1', StopSequence: 1, ArrivalTime: '13:30' },
        { StopUID: 'TPE2', StopSequence: 2, ArrivalTime: '13:45' },
        { StopUID: 'TPE3', StopSequence: 3, DepartureTime: '14:00' },
      ], { subRouteUid: 'TPE307-0' }),
    ], {
      direction: 0,
      subRouteUid: 'TPE307-0',
      stopUids: ['TPE1', 'TPE2', 'TPE3'],
    }, mondayAt1320)

    expect(index.get('TPE1')).toEqual({ minutes: 10 })
    expect(index.get('TPE2')).toEqual({ minutes: 25 })
    expect(index.get('TPE3')).toEqual({ minutes: 40 })
  })

  it('uses the requested sub-route while treating missing SubRouteUID as compatible', () => {
    const schedules: ScheduleItem[] = [
      timetableSchedule([{ StopUID: 'TPE1', ArrivalTime: '13:40' }], { subRouteUid: 'SUB-A' }),
      timetableSchedule([{ StopUID: 'TPE1', ArrivalTime: '13:25' }], { subRouteUid: 'SUB-B' }),
      timetableSchedule([{ StopUID: 'TPE2', ArrivalTime: '13:35' }]),
    ]

    const index = buildRouteScheduleArrivalIndex(schedules, {
      direction: 0,
      subRouteUid: 'SUB-A',
      stopUids: ['TPE1', 'TPE2'],
    }, mondayAt1320)

    expect(index.get('TPE1')).toEqual({ minutes: 20 })
    expect(index.get('TPE2')).toEqual({ minutes: 15 })
  })

  it('borrows a sibling direction schedule by physical stop when no exact schedule exists', () => {
    const index = buildRouteScheduleArrivalIndex([
      timetableSchedule([{ StopUID: 'TPE1', ArrivalTime: '13:32' }], { subRouteUid: 'OTHER' }),
    ], {
      direction: 0,
      subRouteUid: 'MISSING',
      stopUids: ['TPE1', 'TPE2'],
    }, mondayAt1320)

    expect(index.get('TPE1')).toEqual({ minutes: 12 })
    expect(index.has('TPE2')).toBe(false)
  })

  it('does not let an unrelated sibling departure suppress a tomorrow stop time', () => {
    const schedules: ScheduleItem[] = [
      timetableSchedule([
        { StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '13:30' },
      ], { subRouteUid: 'UNRELATED' }),
      timetableSchedule([
        { StopUID: 'TPE2', StopSequence: 2, ArrivalTime: '06:10' },
      ], { subRouteUid: 'SIBLING', serviceDay: { Tuesday: 1 } }),
    ]

    const index = buildRouteScheduleArrivalIndex(schedules, {
      direction: 0,
      subRouteUid: 'MISSING',
      stopUids: ['TPE2'],
    }, mondayAt1320)

    expect(index.get('TPE2')).toEqual({ minutes: 1010, nextDay: true })
  })

  it('preserves today departure fallback precedence over a tomorrow exact time', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'SUB-A',
      Direction: 0,
      Timetables: [
        {
          ServiceDay: { Monday: 1 },
          StopTimes: [{ StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '13:30' }],
        },
        {
          ServiceDay: { Tuesday: 1 },
          StopTimes: [{ StopUID: 'TPE2', StopSequence: 2, ArrivalTime: '06:10' }],
        },
      ],
    }]

    const index = buildRouteScheduleArrivalIndex(schedules, {
      direction: 0,
      subRouteUid: 'SUB-A',
      stopUids: ['TPE2'],
    }, mondayAt1320)

    expect(index.has('TPE2')).toBe(false)
  })

  it('does not turn route-level frequency data into station arrivals', () => {
    const index = buildRouteScheduleArrivalIndex([{
      SubRouteUID: 'SUB-A',
      Direction: 0,
      Frequencys: [{
        ServiceDay: { Monday: 1 },
        StartTime: '13:00',
        EndTime: '14:00',
        MinHeadwayMins: 8,
        MaxHeadwayMins: 12,
      }],
    }], {
      direction: 0,
      subRouteUid: 'SUB-A',
      stopUids: ['TPE1'],
    }, mondayAt1320)

    expect(index.size).toBe(0)
  })

  it('reads one timetable once instead of once per route stop', () => {
    const stopUids = Array.from({ length: 100 }, (_, index) => `STOP-${index + 1}`)
    const stopTimes = stopUids.map((stopUid, index) => ({
      StopUID: stopUid,
      StopSequence: index + 1,
      ArrivalTime: '13:30',
    }))
    let stopTimeReads = 0
    const timetable = {
      ServiceDay: { Monday: 1 },
      get StopTimes() {
        stopTimeReads += 1
        return stopTimes
      },
    } satisfies ScheduleTimetable

    const index = buildRouteScheduleArrivalIndex([{
      Direction: 0,
      Timetables: [timetable],
    }], {
      direction: 0,
      stopUids,
    }, mondayAt1320)

    expect(index.size).toBe(100)
    expect(stopTimeReads).toBe(1)
  })
})
