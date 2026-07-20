import { describe, expect, it } from 'vitest'
import {
  routeEtaCanUseSchedule,
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  routeEtaStateFromStop,
} from './route-eta-status'

const stop = {
  stopUid: 'TPE1',
  stopName: '板橋公車站',
  sequence: 1,
  selected: false,
  etaLabel: null,
  etaTone: 'muted' as const,
}

describe('Route ETA presentation state', () => {
  it('classifies realtime estimates without consulting their label text', () => {
    expect(routeEtaStateFromStop({
      ...stop,
      etaLabel: '文案任意',
      etaTone: 'live',
    })).toEqual({ source: 'realtime', status: 'estimated' })
  })

  it.each([
    ['暫無預估時間', 'no-estimate'],
    ['尚未發車', 'not-departed'],
    ['交管不停靠', 'not-stopping'],
    ['末班車已過', 'last-bus-passed'],
    ['今日未營運', 'not-operating'],
  ] as const)('decodes legacy TDX wording %s once at the boundary', (etaLabel, status) => {
    expect(routeEtaStateFromStop({ ...stop, etaLabel })).toEqual({
      source: 'realtime',
      status,
    })
  })

  it('keeps page placeholders and unavailable messages outside realtime state', () => {
    expect(routeEtaStateFromStop({ ...stop, etaLabel: '更新中' }))
      .toEqual({ source: 'none', status: 'pending' })
    expect(routeEtaStateFromStop({ ...stop, etaLabel: '即時忙線' }))
      .toEqual({ source: 'none', status: 'unavailable' })
  })

  it('drives fallback and realtime classification from typed state', () => {
    expect(routeEtaCanUseSchedule({ source: 'none', status: 'missing' })).toBe(true)
    expect(routeEtaCanUseSchedule({ source: 'realtime', status: 'no-estimate' })).toBe(true)
    expect(routeEtaCanUseSchedule({ source: 'realtime', status: 'not-departed' })).toBe(true)
    expect(routeEtaCanUseSchedule({ source: 'realtime', status: 'last-bus-passed' })).toBe(false)
    expect(routeEtaHasRealtimeEstimate({ source: 'realtime', status: 'estimated' })).toBe(true)
    expect(routeEtaHasRealtimeEstimate({ source: 'schedule', status: 'estimated' })).toBe(false)
    expect(routeEtaIsUnknown({ source: 'none', status: 'missing' })).toBe(true)
    expect(routeEtaIsUnknown({ source: 'realtime', status: 'not-departed' })).toBe(false)
  })
})
