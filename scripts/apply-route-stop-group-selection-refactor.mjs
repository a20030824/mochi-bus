import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is not unique`)
  }
  return source.replace(before, after)
}

const selectorSource = `import type { ResolvedBusQuery } from './bus-query'
import type { StopGroup } from '../lib/tdx'

export type RouteStopGroupSelectionQuery = Pick<
  ResolvedBusQuery,
  'direction' | 'stopUid' | 'routeUid' | 'subRouteUid'
>

/**
 * Select the station-order variant used by both Route SSR and realtime ETA.
 *
 * The secondary lookup intentionally preserves the existing legacy-link rule:
 * when no SubRouteUID is available, direction plus physical StopUID may recover
 * the route pattern even if the optional RouteUID does not identify a group.
 */
export function selectRouteStopGroup(
  groups: readonly StopGroup[],
  query: RouteStopGroupSelectionQuery,
): StopGroup | undefined {
  const exact = groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid),
  )
  if (exact || query.subRouteUid) return exact

  return groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  )
}
`

const selectorTestSource = `import { describe, expect, it } from 'vitest'
import type { StopGroup } from '../lib/tdx'
import {
  selectRouteStopGroup,
  type RouteStopGroupSelectionQuery,
} from './route-stop-group-selection'

const query: RouteStopGroupSelectionQuery = {
  direction: 0,
  stopUid: 'STOP-2',
  routeUid: 'ROUTE-A',
  subRouteUid: 'SUB-A',
}

function stopGroup(
  routeUid: string,
  subRouteUid: string,
  direction: 0 | 1 | 2 = 0,
  stopUid = 'STOP-2',
): StopGroup {
  return {
    direction,
    label: routeUid + ' direction',
    routeUid,
    subRouteUid,
    subRouteName: subRouteUid,
    stops: [{
      routeUid,
      subRouteUid,
      subRouteName: subRouteUid,
      stopUid,
      stopName: stopUid,
      direction,
      sequence: 1,
    }],
  }
}

describe('selectRouteStopGroup', () => {
  it('selects the exact route and sub-route identity', () => {
    const other = stopGroup('ROUTE-A', 'SUB-B')
    const exact = stopGroup('ROUTE-A', 'SUB-A')

    expect(selectRouteStopGroup([other, exact], query)).toBe(exact)
  })

  it('fails closed when an explicit sub-route identity does not match', () => {
    expect(selectRouteStopGroup([
      stopGroup('ROUTE-A', 'SUB-B'),
      stopGroup('ROUTE-B', 'SUB-A'),
    ], query)).toBeUndefined()
  })

  it('prefers an exact route identity before the legacy fallback', () => {
    const fallback = stopGroup('ROUTE-B', 'SUB-B')
    const exact = stopGroup('ROUTE-A', 'SUB-A')

    expect(selectRouteStopGroup([fallback, exact], { ...query, subRouteUid: undefined })).toBe(exact)
  })

  it('preserves the legacy direction-and-stop fallback without a sub-route identity', () => {
    const fallback = stopGroup('ROUTE-B', 'SUB-B')

    expect(selectRouteStopGroup([fallback], {
      ...query,
      routeUid: 'STALE-ROUTE',
      subRouteUid: undefined,
    })).toBe(fallback)
  })

  it('does not cross direction or physical stop identity', () => {
    expect(selectRouteStopGroup([
      stopGroup('ROUTE-A', 'SUB-A', 1),
      stopGroup('ROUTE-A', 'SUB-A', 0, 'OTHER-STOP'),
    ], { ...query, subRouteUid: undefined })).toBeUndefined()
  })
})
`

fs.writeFileSync('src/domain/route-stop-group-selection.ts', selectorSource)
fs.writeFileSync('src/domain/route-stop-group-selection.test.ts', selectorTestSource)

const routePagePath = 'src/domain/route-page-detail.ts'
let routePage = fs.readFileSync(routePagePath, 'utf8')
routePage = replaceOnce(
  routePage,
  "import type { ResolvedBusQuery } from './bus-query'\n",
  "import type { ResolvedBusQuery } from './bus-query'\nimport { selectRouteStopGroup } from './route-stop-group-selection'\n",
  'route page selector import',
)
routePage = routePage.replaceAll('matchingStopGroup(groups, query)', 'selectRouteStopGroup(groups, query)')
routePage = replaceOnce(
  routePage,
  `function matchingStopGroup(groups: StopGroup[], query: ResolvedBusQuery): StopGroup | undefined {
  return groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid),
  ) ?? (!query.subRouteUid ? groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  ) : undefined)
}

`,
  '',
  'route page inline selector',
)
fs.writeFileSync(routePagePath, routePage)

const tdxPath = 'src/lib/tdx.ts'
let tdx = fs.readFileSync(tdxPath, 'utf8')
tdx = replaceOnce(
  tdx,
  "import { selectBestEta } from '../domain/map/eta'\n",
  "import { selectBestEta } from '../domain/map/eta'\nimport { selectRouteStopGroup } from '../domain/route-stop-group-selection'\n",
  'TDX selector import',
)
tdx = replaceOnce(
  tdx,
  `  const group = groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid)
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid)
  ) ?? (!query.subRouteUid ? groups.find((candidate) =>
    candidate.direction === query.direction
    && candidate.stops.some((stop) => stop.stopUid === query.stopUid),
  ) : undefined)
`,
  '  const group = selectRouteStopGroup(groups, query)\n',
  'TDX inline selector',
)
fs.writeFileSync(tdxPath, tdx)
