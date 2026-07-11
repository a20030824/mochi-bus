import { describe, expect, it } from 'vitest'
import type { ScheduleItem } from '../schedule'
import {
  realtimeJourneyEstimate,
  scheduledJourneyEstimates,
  type JourneyLegRef,
} from './journey-estimate'

const ref: JourneyLegRef = {
  key: 'leg-a',
  patternId: 'pattern-a',
  routeUid: 'ROUTE-A',
  subRouteUid: 'SUB-A',
  direction: 0,
  routeName: '同名路線',
  stopUid: 'STOP-1',
}

describe('journey estimates', () => {
  it('selects the earliest valid realtime ETA from unordered rows', () => {
    const estimate = realtimeJourneyEstimate(ref, [
      { RouteUID: 'ROUTE-A', SubRouteUID: 'SUB-A', StopUID: 'STOP-1', Direction: 0, StopStatus: 1 },
      { RouteUID: 'ROUTE-A', SubRouteUID: 'SUB-A', StopUID: 'STOP-1', Direction: 0, EstimateTime: 900 },
      { RouteUID: 'ROUTE-A', SubRouteUID: 'SUB-A', StopUID: 'STOP-1', Direction: 0, EstimateTime: 240 },
    ])

    expect(estimate.estimateSeconds).toBe(240)
    expect(estimate.minutes).toBe(4)
    expect(estimate.source).toBe('realtime')
  })

  it('does not borrow realtime data from another route or subroute with the same display name', () => {
    const estimate = realtimeJourneyEstimate(ref, [
      { RouteUID: 'ROUTE-B', SubRouteUID: 'SUB-A', StopUID: 'STOP-1', Direction: 0, EstimateTime: 60 },
      { RouteUID: 'ROUTE-A', SubRouteUID: 'SUB-B', StopUID: 'STOP-1', Direction: 0, EstimateTime: 120 },
      { RouteUID: 'ROUTE-A', SubRouteUID: 'SUB-A', StopUID: 'STOP-1', Direction: 0, EstimateTime: 600 },
    ])

    expect(estimate.estimateSeconds).toBe(600)
  })

  it('keeps schedule fallback scoped to each RouteUID', () => {
    const secondRef: JourneyLegRef = {
      ...ref,
      key: 'leg-b',
      patternId: 'pattern-b',
      routeUid: 'ROUTE-B',
      subRouteUid: 'SUB-B',
    }
    const schedule = (subRouteUid: string, arrivalTime: string): ScheduleItem[] => [{
      SubRouteUID: subRouteUid,
      Direction: 0,
      Timetables: [{
        ServiceDay: { Monday: 1 },
        StopTimes: [{ StopUID: 'STOP-1', ArrivalTime: arrivalTime }],
      }],
    }]

    const estimates = scheduledJourneyEstimates(
      [ref, secondRef],
      new Map([
        ['ROUTE-A', schedule('SUB-A', '08:20')],
        ['ROUTE-B', schedule('SUB-B', '08:05')],
      ]),
      new Date('2026-07-13T00:00:00.000Z'),
    )

    expect(estimates.get('leg-a')?.minutes).toBe(20)
    expect(estimates.get('leg-b')?.minutes).toBe(5)
  })

  it('reports none instead of schedule when a route has no usable fallback', () => {
    const estimate = scheduledJourneyEstimates([ref], new Map(), new Date('2026-07-13T00:00:00.000Z')).get('leg-a')

    expect(estimate?.minutes).toBeNull()
    expect(estimate?.source).toBe('none')
  })
})
