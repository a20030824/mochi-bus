import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is not unique`)
  }
  return source.replace(before, after)
}

function update(path, transform) {
  const source = fs.readFileSync(path, 'utf8')
  const next = transform(source)
  if (next === source) throw new Error(`${path}: transformation produced no changes`)
  fs.writeFileSync(path, next)
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

export type RouteEtaPresentationState = {
  source: RouteEtaSource
  status: RouteEtaStatus
}

export type RouteEtaTdxInput = {
  hasRealtimeRecord: boolean
  estimateSeconds: number | null
  stopStatus?: number
}

const TDX_STOP_STATUS = {
  0: 'no-estimate',
  1: 'not-departed',
  2: 'not-stopping',
  3: 'last-bus-passed',
  4: 'not-operating',
} as const satisfies Record<number, RouteEtaStatus>

/** Build Route control state directly from TDX data, before formatting labels. */
export function routeEtaStateFromTdx(input: RouteEtaTdxInput): RouteEtaPresentationState {
  if (!input.hasRealtimeRecord) return { source: 'none', status: 'missing' }
  if (input.estimateSeconds !== null) return { source: 'realtime', status: 'estimated' }
  return {
    source: 'realtime',
    status: TDX_STOP_STATUS[input.stopStatus ?? 0] ?? 'unknown',
  }
}

export function routeEtaCanUseSchedule(state: RouteEtaPresentationState): boolean {
  return state.status === 'missing'
    || state.status === 'no-estimate'
    || state.status === 'not-departed'
}

export function routeEtaHasRealtimeEstimate(state: RouteEtaPresentationState): boolean {
  return state.source === 'realtime' && state.status === 'estimated'
}

export function routeEtaIsUnknown(state: RouteEtaPresentationState): boolean {
  return state.status === 'missing' || state.status === 'no-estimate'
}
`)

fs.writeFileSync('src/domain/route-eta-status.test.ts', `import { describe, expect, it } from 'vitest'
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
`)

update('src/lib/tdx.ts', (source) => {
  source = replaceOnce(
    source,
    "import { selectBestEta } from '../domain/map/eta'\nimport { selectRouteStopGroup } from '../domain/route-stop-group-selection'",
    "import { selectBestEta } from '../domain/map/eta'\nimport {\n  routeEtaStateFromTdx,\n  type RouteEtaPresentationState,\n} from '../domain/route-eta-status'\nimport { selectRouteStopGroup } from '../domain/route-stop-group-selection'",
    'tdx imports',
  )

  source = replaceOnce(
    source,
    `export type RouteDetail = {
  routeName: string
  direction: Direction
  label: string
  stops: Array<{
    stopUid: string
    stopName: string
    sequence: number
    selected: boolean
    etaLabel: string | null
    etaTone: RouteEtaTone
  }>
}
`,
    `export type RouteDetail = {
  routeName: string
  direction: Direction
  label: string
  stops: Array<{
    stopUid: string
    stopName: string
    sequence: number
    selected: boolean
    etaLabel: string | null
    etaTone: RouteEtaTone
  }>
}

export type RouteDetailWithEtaStates = {
  detail: RouteDetail
  states: RouteEtaPresentationState[]
}
`,
    'Route detail result type',
  )

  return replaceOnce(
    source,
    `export async function getRouteDetail(env: TDXEnv, query: ResolvedBusQuery): Promise<RouteDetail> {
  const [groups, etaItems] = await Promise.all([
    getRouteStopGroups(env, query.city, query.routeName, query.routeUid),
    getBusETA(env, query),
  ])
  const group = selectRouteStopGroup(groups, query)

  if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
  const stopUids = new Set(group.stops.map((stop) => stop.stopUid))
  const etaByStop = new Map([...stopUids].map((stopUid) => [
    stopUid,
    selectBestEta(etaItems, {
      routeUid: query.routeUid,
      subRouteUid: query.subRouteUid ?? group.subRouteUid,
      stopUid,
      direction: query.direction,
    }),
  ]))

  return {
    routeName: query.routeName,
    direction: query.direction,
    label: group.label,
    stops: group.stops.map((stop) => {
      const eta = etaByStop.get(stop.stopUid)
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
    }),
  }
}`,
    `export async function getRouteDetail(
  env: TDXEnv,
  query: ResolvedBusQuery,
): Promise<RouteDetailWithEtaStates> {
  const [groups, etaItems] = await Promise.all([
    getRouteStopGroups(env, query.city, query.routeName, query.routeUid),
    getBusETA(env, query),
  ])
  const group = selectRouteStopGroup(groups, query)

  if (!group) throw new QueryResolutionError('找不到這個方向的完整站序')
  const stopUids = new Set(group.stops.map((stop) => stop.stopUid))
  const etaByStop = new Map([...stopUids].map((stopUid) => [
    stopUid,
    selectBestEta(etaItems, {
      routeUid: query.routeUid,
      subRouteUid: query.subRouteUid ?? group.subRouteUid,
      stopUid,
      direction: query.direction,
    }),
  ]))
  const timeline = group.stops.map((stop) => {
    const eta = etaByStop.get(stop.stopUid)
    const seconds = typeof eta?.EstimateTime === 'number' ? Math.max(0, eta.EstimateTime) : null
    return {
      stop: {
        stopUid: stop.stopUid,
        stopName: stop.stopName,
        sequence: stop.sequence,
        selected: stop.stopUid === query.stopUid,
        etaLabel: eta
          ? formatETALabel(seconds === null ? null : Math.ceil(seconds / 60), eta.StopStatus ?? 0)
          : null,
        etaTone: (seconds === null ? 'muted' : seconds <= 180 ? 'urgent' : 'live') as RouteEtaTone,
      },
      state: routeEtaStateFromTdx({
        hasRealtimeRecord: Boolean(eta),
        estimateSeconds: seconds,
        stopStatus: eta?.StopStatus,
      }),
    }
  })

  return {
    detail: {
      routeName: query.routeName,
      direction: query.direction,
      label: group.label,
      stops: timeline.map((row) => row.stop),
    },
    states: timeline.map((row) => row.state),
  }
}`,
    'getRouteDetail',
  )
})

update('src/domain/route-page-detail.ts', (source) => {
  source = replaceOnce(
    source,
    `import {
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  routeEtaStatesFromStops,
  type RouteEtaPresentationState,
} from './route-eta-status'`,
    `import {
  routeEtaHasRealtimeEstimate,
  routeEtaIsUnknown,
  type RouteEtaPresentationState,
} from './route-eta-status'`,
    'Route page status imports',
  )
  return replaceOnce(
    source,
    `    let detail = await resolvedDependencies.getRouteDetail(env, query)
    let states = routeEtaStatesFromStops(detail.stops)`,
    `    let { detail, states } = await resolvedDependencies.getRouteDetail(env, query)`,
    'Route page upstream result',
  )
})

update('src/domain/route-page-detail.test.ts', (source) => {
  source = replaceOnce(
    source,
    "import type { ResolvedBusQuery } from './bus-query'",
    "import type { ResolvedBusQuery } from './bus-query'\nimport type { RouteEtaPresentationState } from './route-eta-status'",
    'Route page test imports',
  )

  source = replaceOnce(
    source,
    `const fullyRealtimeDetail: RouteDetail = {
  ...realtimeDetail,
  stops: realtimeDetail.stops.map((stop, index) => index === 2
    ? { ...stop, etaLabel: '18 分', etaTone: 'live' as const }
    : stop),
}
`,
    `const fullyRealtimeDetail: RouteDetail = {
  ...realtimeDetail,
  stops: realtimeDetail.stops.map((stop, index) => index === 2
    ? { ...stop, etaLabel: '18 分', etaTone: 'live' as const }
    : stop),
}

const realtimeStates: RouteEtaPresentationState[] = [
  { source: 'realtime', status: 'estimated' },
  { source: 'realtime', status: 'estimated' },
  { source: 'none', status: 'missing' },
]

const fullyRealtimeStates: RouteEtaPresentationState[] = realtimeStates.map((state, index) => index === 2
  ? { source: 'realtime', status: 'estimated' }
  : state)

function detailResult(detail: RouteDetail, states: RouteEtaPresentationState[]) {
  return { detail, states }
}

function missingStates(detail: RouteDetail): RouteEtaPresentationState[] {
  return detail.stops.map(() => ({ source: 'none', status: 'missing' }))
}
`,
    'Route page test state fixtures',
  )

  source = source.replaceAll(
    'vi.fn(async () => fullyRealtimeDetail)',
    'vi.fn(async () => detailResult(fullyRealtimeDetail, fullyRealtimeStates))',
  )
  source = source.replaceAll(
    'vi.fn(async () => realtimeDetail)',
    'vi.fn(async () => detailResult(realtimeDetail, realtimeStates))',
  )
  source = source.replaceAll(
    'vi.fn(async () => emptyDetail)',
    'vi.fn(async () => detailResult(emptyDetail, missingStates(emptyDetail)))',
  )
  return source
})
