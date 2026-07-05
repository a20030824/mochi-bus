import { describe, expect, it } from 'vitest'
import { nextScheduledMinutes, scheduleClockLabel, type ScheduleItem } from './schedule'

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
    const estimate = nextScheduledMinutes(schedules, {
      stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI071401',
    }, saturdayAt15)
    expect(estimate).toEqual({ minutes: 20, departureBased: false })
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
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI071401' }, saturdayAt15)?.minutes).toBe(20)
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'CYI0714A1' }, saturdayAt15)?.minutes).toBe(50)
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
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15)?.minutes).toBe(20)
  })

  it('rolls over to tomorrow\'s service day when today does not run', () => {
    // 週六 15:00 查一條只跑週日的路線:明天 15:20 = 1460 分後
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Timetables: [{ ServiceDay: { Sunday: 1 }, StopTimes: [{ StopUID: 'CYI304410', ArrivalTime: '15:20' }] }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 1460, departureBased: false, nextDay: true })
  })

  it('falls back to tomorrow\'s first bus after today\'s last one passed', () => {
    // 今天末班 14:00 已過,明天(週日)首班 06:10 = 910 分後
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Timetables: [{
        ServiceDay: { Saturday: 1, Sunday: 1 },
        StopTimes: [
          { StopUID: 'CYI304410', ArrivalTime: '06:10' },
          { StopUID: 'CYI304410', ArrivalTime: '14:00' },
        ],
      }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 910, departureBased: false, nextDay: true })
  })

  it('returns null when neither today nor tomorrow has service', () => {
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
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0, subRouteUid: 'MISSING' }, saturdayAt15)?.minutes).toBe(30)
  })

  it('falls back to origin departure times when the stop has no own times (Tainan-style data)', () => {
    // 台南的 TDX 時刻表每班次只有起點(StopSequence 1)一筆
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TNN1016501',
      Direction: 0,
      Timetables: [
        { ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'TNN16984', StopSequence: 1, DepartureTime: '15:25' }] },
        { ServiceDay: { Saturday: 1 }, StopTimes: [{ StopUID: 'TNN16984', StopSequence: 1, DepartureTime: '16:05' }] },
      ],
    }]
    const estimate = nextScheduledMinutes(schedules, { stopUid: 'TNN99999', direction: 0 }, saturdayAt15)
    expect(estimate).toEqual({ minutes: 25, departureBased: true })
  })

  it('uses the max headway during an active frequency window (Taipei-style data)', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE1234501',
      Direction: 0,
      Frequencys: [
        { StartTime: '05:10', EndTime: '22:20', MinHeadwayMins: 15, MaxHeadwayMins: 20, ServiceDay: { Saturday: 1 } },
        { StartTime: '05:10', EndTime: '22:20', MinHeadwayMins: 8, MaxHeadwayMins: 12, ServiceDay: { Monday: 1 } },
      ],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'TPE99', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 20, departureBased: true, headwayMinutes: [15, 20] })
  })

  it('waits for the next frequency window before service starts', () => {
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Frequencys: [
        { StartTime: '16:00', EndTime: '19:00', MinHeadwayMins: 10, MaxHeadwayMins: 15, ServiceDay: { Saturday: 1 } },
      ],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'TPE99', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 60, departureBased: true })
  })

  it('waits for tomorrow\'s frequency window when today has none', () => {
    // 週六 15:00,班距時段只在週日 05:00 開始 = 840 分後
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Frequencys: [
        { StartTime: '05:00', EndTime: '23:00', MinHeadwayMins: 10, MaxHeadwayMins: 15, ServiceDay: { Sunday: 1 } },
      ],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'TPE99', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 840, departureBased: true, nextDay: true })
  })

  it('prefers the stop\'s own time over the departure fallback', () => {
    const schedules: ScheduleItem[] = [{
      Direction: 0,
      Timetables: [{
        ServiceDay: { Saturday: 1 },
        StopTimes: [
          { StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '15:05' },
          { StopUID: 'CYI304410', StopSequence: 7, ArrivalTime: '15:20' },
        ],
      }],
    }]
    expect(nextScheduledMinutes(schedules, { stopUid: 'CYI304410', direction: 0 }, saturdayAt15))
      .toEqual({ minutes: 20, departureBased: false })
  })
})

describe('scheduleClockLabel', () => {
  it('keeps relative time within an hour', () => {
    expect(scheduleClockLabel({ minutes: 60, departureBased: true }, saturdayAt15)).toBeNull()
    expect(scheduleClockLabel({ minutes: 12, departureBased: false }, saturdayAt15)).toBeNull()
  })

  it('switches to an absolute Taipei clock beyond an hour', () => {
    // 台北 15:00 + 131 分 = 17:11
    expect(scheduleClockLabel({ minutes: 131, departureBased: true }, saturdayAt15)).toBe('17:11 發車')
    expect(scheduleClockLabel({ minutes: 61, departureBased: false }, saturdayAt15)).toBe('16:01 到站')
  })

  it('never converts headway estimates (minutes is a headway, not a departure)', () => {
    expect(scheduleClockLabel({ minutes: 90, departureBased: true, headwayMinutes: [60, 90] }, saturdayAt15)).toBeNull()
  })

  it('labels next-day service with 明日 regardless of how close it is', () => {
    // 週六 15:00 + 1460 分 = 週日 15:20
    expect(scheduleClockLabel({ minutes: 1460, departureBased: false, nextDay: true }, saturdayAt15)).toBe('明日 15:20 到站')
    expect(scheduleClockLabel({ minutes: 910, departureBased: true, nextDay: true }, saturdayAt15)).toBe('明日 06:10 發車')
    // 快午夜時明天首班可能不到一小時,一樣給「明日 + 時刻」,不給相對分鐘
    expect(scheduleClockLabel({ minutes: 40, departureBased: true, nextDay: true }, saturdayAt15)).not.toBeNull()
  })
})
