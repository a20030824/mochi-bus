import type { BusETAItem } from '../../lib/tdx'
import { nextScheduledMinutes, type ScheduleItem } from '../schedule'
import { selectBestEta } from './eta'

export type JourneyLegRef = {
  key: string
  patternId: string
  routeUid: string
  subRouteUid?: string
  direction: 0 | 1 | 2
  routeName: string
  stopUid: string
}

export type JourneyEstimate = {
  key: string
  routeName: string
  stopUid: string
  estimateSeconds: number | null
  minutes: number | null
  stopStatus: number | null
  source: 'none' | 'realtime' | 'schedule'
  departureBased: boolean
  headwayMinutes: [number, number] | null
  nextDay: boolean
}

export function realtimeJourneyEstimate(ref: JourneyLegRef, items: BusETAItem[]): JourneyEstimate {
  const item = selectBestEta(items, {
    routeUid: ref.routeUid,
    subRouteUid: ref.subRouteUid,
    stopUid: ref.stopUid,
    direction: ref.direction,
  })
  const estimateSeconds = typeof item?.EstimateTime === 'number' ? Math.max(0, item.EstimateTime) : null
  return {
    key: ref.key,
    routeName: ref.routeName,
    stopUid: ref.stopUid,
    estimateSeconds,
    minutes: estimateSeconds === null ? null : Math.ceil(estimateSeconds / 60),
    stopStatus: item?.StopStatus ?? null,
    source: estimateSeconds === null ? 'none' : 'realtime',
    departureBased: false,
    headwayMinutes: null,
    nextDay: false,
  }
}

export function scheduledJourneyEstimates(
  refs: JourneyLegRef[],
  schedulesByRouteUid: ReadonlyMap<string, ScheduleItem[]>,
  now: Date,
): Map<string, JourneyEstimate> {
  return new Map(refs.map((ref) => {
    const scheduled = nextScheduledMinutes(schedulesByRouteUid.get(ref.routeUid) ?? [], {
      stopUid: ref.stopUid,
      direction: ref.direction,
      subRouteUid: ref.subRouteUid,
    }, now)
    return [ref.key, {
      key: ref.key,
      routeName: ref.routeName,
      stopUid: ref.stopUid,
      estimateSeconds: scheduled === null ? null : scheduled.minutes * 60,
      minutes: scheduled?.minutes ?? null,
      stopStatus: null,
      source: scheduled === null ? 'none' as const : 'schedule' as const,
      departureBased: scheduled?.departureBased ?? false,
      headwayMinutes: scheduled?.headwayMinutes ?? null,
      nextDay: scheduled?.nextDay ?? false,
    }] as const
  }))
}
