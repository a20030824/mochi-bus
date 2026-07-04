import { describe, expect, it } from 'vitest'
import { nextScheduledMinutes, type ScheduleItem } from './schedule'

// 2026-07-04 是週六,UTC 07:00 = 台北時間 15:00。
const saturdayAt15 = new Date('2026-07-04T07:00:00.000Z')

describe('nextScheduledMinutes', () => {
  it('picks the nearest upcoming stop time on today\'s service day', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'CYI071401',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Saturday: 1 },
        StopTimes: [
          { StopUID: 'CYI304410', ArrivalTime: '14:50' },
          { StopUID: 'CYI304410', ArrivalTime: '15:20' },
          { StopUID: 'CYI304410', ArrivalTime: '15:40' },
        ],
      }],
    }]
    const minutes = nextScheduledMinutes(schedules, {
      stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI071401',
    }, saturdayAt15)
    expect(minutes).toBe(20)
  })

  it('disambiguates two subroutes sharing the same stopUid+direction', () => {
    const schedules: ScheduleItem[] = [
      {
        SubRouteUID: 'CYI071401',
        Direction: 0,
        Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:20' }] }],
      },
      {
        SubRouteUID: 'CYI0714A1',
        Direction: 0,
        Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:50' }] }],
      },
    ]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI071401' }, saturdayAt15)).toBe(20)
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI0714A1' }, saturdayAt15)).toBe(50)
  })

  it('takes the earliest time across all matching schedules when subroute is unknown', () => {
    const schedules: ScheduleItem[] = [
      {
        SubRouteUID: 'CYI0714A1',
        Direction: 0,
        Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:50' }] }],
      },
      {
        SubRouteUID: 'CYI071401',
        Direction: 0,
        Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:20' }] }],
      },
    ]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15)).toBe(20)
  })

  it('ignores service days that do not run today', () => {
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Timetables: [{ ServiceDay: { Sunday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:20' }] }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15)).toBeNull()
  })

  it('ignores stop times that already passed', () => {
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '14:00' }] }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15)).toBeNull()
  })

  it('falls back to matching by stopUid when no subroute schedule matches', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'OTHER',
      Direction: 0,
      Timetables: [{ ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:30' }] }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'MISSING' }, saturdayAt15)).toBe(30)
  })
})
