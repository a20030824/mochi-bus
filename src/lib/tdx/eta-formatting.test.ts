import { describe, expect, it } from 'vitest'
import type { ResolvedBusQuery } from '../../domain/bus-query'
import {
  formatETALabel,
  formatStopStatus,
  toETAResult,
  type BusETAItem,
} from './eta-formatting'

const query: ResolvedBusQuery = {
  city: 'Taipei',
  routeName: '307',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-0',
  stopName: '原查詢站名',
  stopUid: 'QUERY_STOP',
  direction: 0,
}

describe('TDX ETA formatting boundary', () => {
  it('preserves immediate and ordinary arrival labels', () => {
    expect(formatETALabel(0, 0)).toBe('即將進站')
    expect(formatETALabel(1, 0)).toBe('即將進站')
    expect(formatETALabel(2, 0)).toBe('2 分')
    expect(formatETALabel(17, 4)).toBe('17 分')
  })

  it('preserves every known stop status and the unknown fallback', () => {
    expect([0, 1, 2, 3, 4].map(formatStopStatus)).toEqual([
      '暫無預估時間',
      '尚未發車',
      '交管不停靠',
      '末班車已過',
      '今日未營運',
    ])
    expect(formatStopStatus(99)).toBe('暫無資料')
    expect(formatETALabel(null, 1)).toBe('尚未發車')
  })

  it('maps realtime fields, clamps negative estimates, and prefers DataTime', () => {
    const now = new Date('2026-07-21T08:10:00.001Z')
    const item: BusETAItem = {
      StopName: { Zh_tw: 'TDX 站名' },
      StopUID: 'TDX_STOP',
      Direction: 1,
      EstimateTime: -30,
      StopStatus: 3,
      DataTime: '2026-07-21T08:07:00.000Z',
      SrcUpdateTime: '2026-07-21T08:09:00.000Z',
    }

    expect(toETAResult(item, query, now)).toEqual({
      routeName: '307',
      stopName: 'TDX 站名',
      stopUid: 'TDX_STOP',
      direction: 1,
      estimateSeconds: 0,
      minutes: 0,
      label: '即將進站',
      stopStatus: 3,
      statusLabel: '正常',
      dataTime: '2026-07-21T08:07:00.000Z',
      fetchedAt: now.toISOString(),
      stale: true,
      source: 'realtime',
    })
  })

  it('uses query identity and stop status when realtime fields are absent', () => {
    const now = new Date('2026-07-21T08:10:00.000Z')
    const result = toETAResult({
      EstimateTime: null,
      StopStatus: 4,
      SrcTransTime: '2026-07-21T08:09:00.000Z',
    }, query, now)

    expect(result).toMatchObject({
      routeName: '307',
      stopName: '原查詢站名',
      stopUid: 'QUERY_STOP',
      direction: 0,
      estimateSeconds: null,
      minutes: null,
      label: '今日未營運',
      statusLabel: '今日未營運',
      dataTime: '2026-07-21T08:09:00.000Z',
      stale: false,
      source: 'none',
    })
  })

  it('marks data stale only after the three-minute boundary', () => {
    const now = new Date('2026-07-21T08:10:00.000Z')
    const atBoundary = toETAResult({
      EstimateTime: 60,
      DataTime: '2026-07-21T08:07:00.000Z',
    }, query, now)
    const beyondBoundary = toETAResult({
      EstimateTime: 60,
      DataTime: '2026-07-21T08:06:59.999Z',
    }, query, now)

    expect(atBoundary.stale).toBe(false)
    expect(beyondBoundary.stale).toBe(true)
  })

  it('does not call missing or invalid timestamps stale', () => {
    const now = new Date('2026-07-21T08:10:00.000Z')
    expect(toETAResult({ EstimateTime: 120 }, query, now).stale).toBe(false)
    expect(toETAResult({ EstimateTime: 120, UpdateTime: 'invalid' }, query, now).stale).toBe(false)
  })
})
