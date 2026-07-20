import { describe, expect, it } from 'vitest'
import {
  routeEtaCanUseSchedule,
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  routeEtaStateFromTdx,
} from './route-eta-status'

describe('Route ETA presentation state', () => {
  it('marks a station without any realtime record as missing', () => {
    expect(routeEtaStateFromTdx({
      hasRealtimeRecord: false,
      estimateSeconds: null,
      stopStatus: 1,
    })).toEqual({ source: 'none', status: 'missing' })
  })

  it('treats a numeric estimate as realtime regardless of stop status', () => {
    expect(routeEtaStateFromTdx({
      hasRealtimeRecord: true,
      estimateSeconds: 120,
      stopStatus: 4,
    })).toEqual({ source: 'realtime', status: 'estimated' })
  })

  it.each([
    [0, 'no-estimate'],
    [1, 'not-departed'],
    [2, 'not-stopping'],
    [3, 'last-bus-passed'],
    [4, 'not-operating'],
    [99, 'unknown'],
  ] as const)('maps TDX StopStatus %s before labels are formatted', (stopStatus, status) => {
    expect(routeEtaStateFromTdx({
      hasRealtimeRecord: true,
      estimateSeconds: null,
      stopStatus,
    })).toEqual({ source: 'realtime', status })
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
