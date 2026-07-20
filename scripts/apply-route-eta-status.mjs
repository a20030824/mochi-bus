import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`${label}: source block is not unique`)
  return source.replace(before, after)
}

function update(path, transform) {
  const source = fs.readFileSync(path, 'utf8')
  fs.writeFileSync(path, transform(source))
}

fs.writeFileSync('src/domain/route-eta-status.ts', `export type RouteEtaSource = 'realtime' | 'schedule' | 'none'

export type RouteEtaStatus =
  | 'estimated'
  | 'missing'
  | 'no-estimate'
  | 'not-departed'
  | 'not-stopping'
  | 'last-bus-passed'
  | 'not-operating'
  | 'unknown'
  | 'pending'
  | 'unavailable'

export function routeEtaStatusFromStopStatus(status: number): RouteEtaStatus {
  return ({
    0: 'no-estimate',
    1: 'not-departed',
    2: 'not-stopping',
    3: 'last-bus-passed',
    4: 'not-operating',
  } as Record<number, RouteEtaStatus>)[status] ?? 'unknown'
}

export function routeEtaCanUseSchedule(status: RouteEtaStatus): boolean {
  return status === 'missing' || status === 'no-estimate' || status === 'not-departed'
}

export function routeEtaHasRealtimeEstimate(source: RouteEtaSource, status: RouteEtaStatus): boolean {
  return source === 'realtime' && status === 'estimated'
}

export function routeEtaIsUnknown(status: RouteEtaStatus): boolean {
  return status === 'missing' || status === 'no-estimate'
}
`)

fs.writeFileSync('src/domain/route-eta-status.test.ts', `import { describe, expect, it } from 'vitest'
import {
  routeEtaCanUseSchedule,
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  routeEtaStatusFromStopStatus,
} from './route-eta-status'

describe('Route ETA status', () => {
  it('preserves TDX stop-status semantics without depending on display text', () => {
    expect([0, 1, 2, 3, 4, 99].map(routeEtaStatusFromStopStatus)).toEqual([
      'no-estimate',
      'not-departed',
      'not-stopping',
      'last-bus-passed',
      'not-operating',
      'unknown',
    ])
  })

  it('limits timetable fallback to missing or provisional states', () => {
    expect(routeEtaCanUseSchedule('missing')).toBe(true)
    expect(routeEtaCanUseSchedule('no-estimate')).toBe(true)
    expect(routeEtaCanUseSchedule('not-departed')).toBe(true)
    expect(routeEtaCanUseSchedule('not-stopping')).toBe(false)
    expect(routeEtaCanUseSchedule('last-bus-passed')).toBe(false)
    expect(routeEtaCanUseSchedule('not-operating')).toBe(false)
  })

  it('separates realtime estimates from schedule and unknown presentations', () => {
    expect(routeEtaHasRealtimeEstimate('realtime', 'estimated')).toBe(true)
    expect(routeEtaHasRealtimeEstimate('schedule', 'estimated')).toBe(false)
    expect(routeEtaHasRealtimeEstimate('realtime', 'not-departed')).toBe(false)
    expect(routeEtaIsUnknown('missing')).toBe(true)
    expect(routeEtaIsUnknown('no-estimate')).toBe(true)
    expect(routeEtaIsUnknown('not-departed')).toBe(false)
  })
})
`)

fs.writeFileSync('src/domain/route-timeline-fallback.ts', `import { buildRouteScheduleArrivalIndex } from './route-schedule-arrival-index'
import {
  routeEtaCanUseSchedule,
  type RouteEtaSource,
  type RouteEtaStatus,
} from './route-eta-status'
import type { ScheduleItem } from './schedule'

export const ROUTE_UNKNOWN_ETA_LABEL = '—'

export type RouteTimelineStopPresentation = {
  stopUid: string
  etaLabel: string | null
  etaTone: 'live' | 'urgent' | 'muted'
  etaSource: RouteEtaSource
  etaStatus: RouteEtaStatus
}

export type RouteTimelineScheduleQuery = {
  direction: number
  subRouteUid?: string
}

export function routeTimelineNeedsSchedule(
  stops: readonly RouteTimelineStopPresentation[],
): boolean {
  return stops.some(isScheduleEligible)
}

export function applyRouteTimelineFallback<T extends RouteTimelineStopPresentation>(
  stops: readonly T[],
  schedules: ScheduleItem[],
  query: RouteTimelineScheduleQuery,
  now: Date,
): T[] {
  const scheduledArrivals = buildRouteScheduleArrivalIndex(schedules, {
    direction: query.direction,
    subRouteUid: query.subRouteUid,
    stopUids: stops.filter(isScheduleEligible).map((stop) => stop.stopUid),
  }, now)

  return stops.map((stop) => {
    if (!isScheduleEligible(stop)) return stop

    const estimate = scheduledArrivals.get(stop.stopUid)
    const scheduledLabel = estimate
      ? routeScheduledClockLabel(estimate.minutes, Boolean(estimate.nextDay), now)
      : null

    if (scheduledLabel) {
      return {
        ...stop,
        etaLabel: scheduledLabel,
        etaTone: 'muted',
        etaSource: 'schedule',
        etaStatus: 'estimated',
      } as T
    }

    return {
      ...stop,
      etaLabel: stop.etaStatus === 'not-departed' ? stop.etaLabel : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    } as T
  })
}

function isScheduleEligible(stop: RouteTimelineStopPresentation): boolean {
  return stop.etaTone === 'muted' && routeEtaCanUseSchedule(stop.etaStatus)
}

function routeScheduledClockLabel(minutes: number, nextDay: boolean, now: Date): string {
  const arrival = new Date(now.getTime() + minutes * 60_000)
  const clock = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(arrival)
  const crossesTaipeiDate = taipeiDateKey(arrival) !== taipeiDateKey(now)
  return \`表定 \${nextDay || crossesTaipeiDate ? '明日 ' : ''}\${clock}\`
}

function taipeiDateKey(value: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(value)
}
`)

fs.writeFileSync('src/domain/route-timeline-fallback.test.ts', `import { describe, expect, it } from 'vitest'
import type { ScheduleItem } from './schedule'
import {
  applyRouteTimelineFallback,
  ROUTE_UNKNOWN_ETA_LABEL,
  routeTimelineNeedsSchedule,
} from './route-timeline-fallback'

const now = new Date('2026-07-20T05:20:00.000Z') // Monday 13:20 in Taipei
const query = { direction: 0, subRouteUid: 'TPE307-0' }

const stops = [
  { stopUid: 'TPE1', etaLabel: '12 分', etaTone: 'live' as const, etaSource: 'realtime' as const, etaStatus: 'estimated' as const },
  { stopUid: 'TPE2', etaLabel: '尚未發車', etaTone: 'muted' as const, etaSource: 'realtime' as const, etaStatus: 'not-departed' as const },
  { stopUid: 'TPE3', etaLabel: null, etaTone: 'muted' as const, etaSource: 'none' as const, etaStatus: 'missing' as const },
]

function timetable(stopUid: string, time: string): ScheduleItem[] {
  return [{
    SubRouteUID: 'TPE307-0',
    Direction: 0,
    Timetables: [{
      ServiceDay: { Monday: 1 },
      StopTimes: [{ StopUID: stopUid, StopSequence: 2, ArrivalTime: time }],
    }],
  }]
}

describe('Route timeline timetable fallback', () => {
  it('uses typed state instead of display wording to decide schedule eligibility', () => {
    expect(routeTimelineNeedsSchedule(stops)).toBe(true)
    expect(routeTimelineNeedsSchedule([
      { stopUid: 'TPE1', etaLabel: '文案可以改', etaTone: 'muted', etaSource: 'realtime', etaStatus: 'no-estimate' },
    ])).toBe(true)
    expect(routeTimelineNeedsSchedule([
      { stopUid: 'TPE2', etaLabel: '暫無預估時間', etaTone: 'muted', etaSource: 'realtime', etaStatus: 'last-bus-passed' },
    ])).toBe(false)
  })

  it('fills only exact stop-level timetable arrivals and keeps realtime rows untouched', () => {
    const result = applyRouteTimelineFallback(stops, timetable('TPE3', '13:45'), query, now)

    expect(result[0]).toEqual(stops[0])
    expect(result[1]).toMatchObject({ etaLabel: '尚未發車', etaTone: 'muted', etaSource: 'realtime', etaStatus: 'not-departed' })
    expect(result[2]).toMatchObject({ etaLabel: '表定 13:45', etaTone: 'muted', etaSource: 'schedule', etaStatus: 'estimated' })
  })

  it('preserves not-departed semantics even when its display wording changes', () => {
    const provisional = [{
      ...stops[1],
      etaLabel: '等待起點發車',
    }]
    expect(applyRouteTimelineFallback(provisional, [], query, now)[0].etaLabel).toBe('等待起點發車')
  })

  it('does not present origin-only departure data as a stop arrival', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Monday: 1 },
        StopTimes: [{ StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '13:30' }],
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)

    expect(result[1].etaLabel).toBe('尚未發車')
    expect(result[2].etaLabel).toBe(ROUTE_UNKNOWN_ETA_LABEL)
  })

  it('does not present route-level headway as a station arrival', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Frequencys: [{
        ServiceDay: { Monday: 1 },
        StartTime: '13:00',
        EndTime: '14:00',
        MinHeadwayMins: 8,
        MaxHeadwayMins: 12,
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)
    expect(result[2].etaLabel).toBe(ROUTE_UNKNOWN_ETA_LABEL)
  })

  it('labels tomorrow stop-level times without turning them into relative ETA', () => {
    const schedules: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Tuesday: 1 },
        StopTimes: [{ StopUID: 'TPE3', StopSequence: 3, ArrivalTime: '06:10' }],
      }],
    }]

    const result = applyRouteTimelineFallback(stops, schedules, query, now)
    expect(result[2].etaLabel).toBe('表定 明日 06:10')
  })

  it('labels after-midnight times from the current service day as tomorrow', () => {
    const lateNow = new Date('2026-07-20T15:50:00.000Z') // Monday 23:50 in Taipei
    const result = applyRouteTimelineFallback(stops, timetable('TPE3', '24:20'), query, lateNow)
    expect(result[2].etaLabel).toBe('表定 明日 00:20')
  })

  it('preserves explicit non-service statuses instead of replacing them with a dash', () => {
    const result = applyRouteTimelineFallback([
      { stopUid: 'TPE1', etaLabel: '交管不停靠', etaTone: 'muted' as const, etaSource: 'realtime' as const, etaStatus: 'not-stopping' as const },
      { stopUid: 'TPE2', etaLabel: '末班車已過', etaTone: 'muted' as const, etaSource: 'realtime' as const, etaStatus: 'last-bus-passed' as const },
      { stopUid: 'TPE3', etaLabel: '今日未營運', etaTone: 'muted' as const, etaSource: 'realtime' as const, etaStatus: 'not-operating' as const },
    ], [], query, now)

    expect(result.map((stop) => stop.etaLabel)).toEqual(['交管不停靠', '末班車已過', '今日未營運'])
  })
})
`)

update('src/lib/tdx.ts', (source) => {
  let next = replaceOnce(
    source,
    "import { selectRouteStopGroup } from '../domain/route-stop-group-selection'\n",
    "import { selectRouteStopGroup } from '../domain/route-stop-group-selection'\nimport {\n  routeEtaStatusFromStopStatus,\n  type RouteEtaSource,\n  type RouteEtaStatus,\n} from '../domain/route-eta-status'\n",
    'route ETA status import',
  )
  next = replaceOnce(
    next,
    `    etaLabel: string | null
    etaTone: RouteEtaTone
`,
    `    etaLabel: string | null
    etaTone: RouteEtaTone
    etaSource: RouteEtaSource
    etaStatus: RouteEtaStatus
`,
    'RouteDetail stop fields',
  )
  next = replaceOnce(
    next,
    `      const eta = etaByStop.get(stop.stopUid)
      const seconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
      return {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(seconds === null ? null : Math.ceil(seconds / 60), eta.StopStatus ?? 0)
          : null,
        etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteEtaTone,
      }
`,
    `      const eta = etaByStop.get(stop.stopUid)
      const seconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
      const etaSource: RouteEtaSource = eta ? 'realtime' : 'none'
      const etaStatus: RouteEtaStatus = seconds !== null
        ? 'estimated'
        : eta ? routeEtaStatusFromStopStatus(eta.StopStatus ?? 0) : 'missing'
      return {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(seconds === null ? null : Math.ceil(seconds / 60), eta.StopStatus ?? 0)
          : null,
        etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteEtaTone,
        etaSource,
        etaStatus,
      }
`,
    'getRouteDetail stop presentation',
  )
  return next
})

update('src/domain/route-page-detail.ts', (source) => {
  let next = replaceOnce(
    source,
    `import type { ResolvedBusQuery } from './bus-query'
`,
    `import type { ResolvedBusQuery } from './bus-query'
import {
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  type RouteEtaStatus,
} from './route-eta-status'
`,
    'route page typed status import',
  )
  next = replaceOnce(
    next,
    "  return { detail: routeDetailWithoutEta(query, group, '更新中') }",
    "  return { detail: routeDetailWithoutEta(query, group, '更新中', 'pending') }",
    'pending shell status',
  )
  next = replaceOnce(
    next,
    "    if (detail.stops.some((stop) => stop.etaTone === 'live' || stop.etaTone === 'urgent')) {",
    "    if (detail.stops.some((stop) => routeEtaHasRealtimeEstimate(stop.etaSource, stop.etaStatus))) {",
    'realtime classification',
  )
  next = replaceOnce(
    next,
    "      detail: routeDetailWithoutEta(query, group, unavailableLabel(warning)),",
    "      detail: routeDetailWithoutEta(query, group, unavailableLabel(warning), 'unavailable'),",
    'unavailable shell status',
  )
  next = replaceOnce(
    next,
    `  selectedStatus: string,
): RouteDetail {
`,
    `  selectedStatus: string,
  selectedEtaStatus: RouteEtaStatus,
): RouteDetail {
`,
    'routeDetailWithoutEta signature',
  )
  next = replaceOnce(
    next,
    `      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
`,
    `      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
      etaSource: 'none',
      etaStatus: stop.stopUid === query.stopUid ? selectedEtaStatus : 'missing',
`,
    'routeDetailWithoutEta presentation',
  )
  next = replaceOnce(
    next,
    `    stops: detail.stops.map((stop) => stop.selected
      && (stop.etaLabel === null || stop.etaLabel === ROUTE_UNKNOWN_ETA_LABEL)
      ? { ...stop, etaLabel: selectedStatus, etaTone: 'muted' }
      : stop),
`,
    `    stops: detail.stops.map((stop) => stop.selected && routeEtaIsUnknown(stop.etaStatus)
      ? {
          ...stop,
          etaLabel: selectedStatus,
          etaTone: 'muted',
          etaSource: 'none',
          etaStatus: 'unavailable',
        }
      : stop),
`,
    'selected unknown state',
  )
  return next
})

update('src/domain/route-page-detail.test.ts', (source) => {
  let next = replaceOnce(
    source,
    `    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: '12 分', etaTone: 'live' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '即將進站', etaTone: 'urgent' },
    { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3, selected: false, etaLabel: null, etaTone: 'muted' },
`,
    `    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: '12 分', etaTone: 'live', etaSource: 'realtime', etaStatus: 'estimated' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '即將進站', etaTone: 'urgent', etaSource: 'realtime', etaStatus: 'estimated' },
    { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3, selected: false, etaLabel: null, etaTone: 'muted', etaSource: 'none', etaStatus: 'missing' },
`,
    'realtime detail fixture',
  )
  next = replaceOnce(
    next,
    `    ? { ...stop, etaLabel: '18 分', etaTone: 'live' as const }
`,
    `    ? { ...stop, etaLabel: '18 分', etaTone: 'live' as const, etaSource: 'realtime' as const, etaStatus: 'estimated' as const }
`,
    'fully realtime fixture',
  )
  next = next.replaceAll(
    "stops: realtimeDetail.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted' })),",
    "stops: realtimeDetail.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted', etaSource: 'none', etaStatus: 'missing' })),",
  )
  next = replaceOnce(
    next,
    `    expect(result.detail.stops[2]).toMatchObject({ etaLabel: '表定 13:45', etaTone: 'muted' })
`,
    `    expect(result.detail.stops[2]).toMatchObject({
      etaLabel: '表定 13:45',
      etaTone: 'muted',
      etaSource: 'schedule',
      etaStatus: 'estimated',
    })
`,
    'scheduled source assertion',
  )
  return next
})

update('src/domain/route-page-identity.test.ts', (source) => replaceOnce(
  source,
  `    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: null, etaTone: 'muted' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '更新中', etaTone: 'muted' },
`,
  `    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: null, etaTone: 'muted', etaSource: 'none', etaStatus: 'missing' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '更新中', etaTone: 'muted', etaSource: 'none', etaStatus: 'pending' },
`,
  'route identity fixture',
))
