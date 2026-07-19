import { describe, expect, it } from 'vitest'
import { scheduledCitiesAt } from './scheduled-cities.mjs'
import {
  latestClosedSnapshotScheduleDate,
  scheduledCitiesForTaipeiDate,
  scheduledSnapshotWindow,
} from './snapshot-schedule.mjs'
import { snapshotWindowIdentity } from './window-contract.mjs'

describe('snapshot schedule contract', () => {
  it('maps every Taipei weekday to the single shared city schedule', () => {
    expect(scheduledCitiesForTaipeiDate('2026-07-19')).toEqual([
      'Taoyuan', 'YilanCounty', 'HualienCounty', 'TaitungCounty',
    ])
    expect(scheduledCitiesForTaipeiDate('2026-07-20')).toEqual(['Taipei', 'NewTaipei'])
    expect(scheduledCitiesForTaipeiDate('2026-07-21')).toEqual(['Chiayi', 'Keelung', 'Hsinchu', 'HsinchuCounty'])
    expect(scheduledCitiesForTaipeiDate('2026-07-22')).toEqual([
      'Tainan', 'MiaoliCounty', 'NantouCounty', 'PenghuCounty', 'KinmenCounty', 'LienchiangCounty',
    ])
    expect(scheduledCitiesForTaipeiDate('2026-07-23')).toEqual(['ChiayiCounty', 'ChanghuaCounty', 'PingtungCounty'])
    expect(scheduledCitiesForTaipeiDate('2026-07-24')).toEqual(['Taichung'])
    expect(scheduledCitiesForTaipeiDate('2026-07-25')).toEqual(['Kaohsiung', 'YunlinCounty'])
  })

  it('maps UTC Sunday 23:45 to Taipei Monday 07:45 without runner timezone state', () => {
    const now = new Date('2026-07-19T23:45:00.000Z')
    expect(scheduledCitiesAt(now)).toEqual(['Taipei', 'NewTaipei'])
    expect(latestClosedSnapshotScheduleDate(now)).toBe('2026-07-20')
  })

  it('keeps a delayed pre-close run attached to the previous closed date', () => {
    expect(latestClosedSnapshotScheduleDate(new Date('2026-07-20T23:29:59.000Z'))).toBe('2026-07-20')
    expect(latestClosedSnapshotScheduleDate(new Date('2026-07-20T23:30:00.000Z'))).toBe('2026-07-21')
  })

  it('produces exactly the same scheduled window identity as A5a', () => {
    const expected = scheduledSnapshotWindow('Taipei', '2026-07-20')
    expect(expected).toEqual({
      windowId: 'v1:Taipei:2026-07-20:0317',
      scheduledAt: '2026-07-19T19:17:00.000Z',
      runKind: 'scheduled',
    })
    expect(snapshotWindowIdentity({
      city: 'Taipei',
      now: new Date('2026-07-19T23:45:00.000Z'),
    })).toEqual(expected)
  })
})
