import { describe, expect, test } from 'vitest'
import { buildRouteTimetable } from '../src/domain/map/timetable'

const variant = {
  direction: 0 as const,
  subRouteUid: 'TEST',
  stops: [{ stopUid: 'S1', stopName: '起點', sequence: 1 }],
}

function serviceDay(days: number[]) {
  const keys = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
  return Object.fromEntries(keys.map((key, index) => [key, days.includes(index) ? 1 : 0]))
}

function schedule(time: string, days: number[]) {
  return {
    Direction: 0,
    SubRouteUID: 'TEST',
    Timetables: [{
      ServiceDay: serviceDay(days),
      StopTimes: [{ StopUID: 'S1', StopSequence: 1, DepartureTime: time }],
    }],
  }
}

describe('timetable service-day normalization', () => {
  test('merges overlapping rules into one complete timetable for each weekday', () => {
    const result = buildRouteTimetable(
      [schedule('06:00', [0, 1, 2, 3, 4, 5, 6]), schedule('07:00', [4])] as any,
      variant,
      undefined,
      new Date('2026-07-16T04:00:00Z'),
    )

    const current = result.services.filter((service) => service.today)
    expect(current).toHaveLength(1)
    expect(current[0].label).toBe('週四')
    expect(current[0].times).toEqual(['06:00', '07:00'])
  })

  test('collapses identical weekday timetables back into a 平日 group', () => {
    const result = buildRouteTimetable(
      [1, 2, 3, 4, 5].map((day) => schedule('06:00', [day])) as any,
      variant,
      undefined,
      new Date('2026-07-13T04:00:00Z'),
    )

    expect(result.services).toHaveLength(1)
    expect(result.services[0]).toMatchObject({ label: '平日', days: [1, 2, 3, 4, 5], today: true })
  })
})
