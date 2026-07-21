import { describe, expect, it } from 'vitest'
import type { TelemetryCity } from '../../observability/telemetry'
import {
  QueryResolutionError,
  createTDXBusRouteQueries,
  mergeEquivalentStopGroups,
  tdxRouteScope,
  type RouteStop,
  type StopGroup,
  type TDXBusRouteQueryDependencies,
} from './bus-route-queries'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const env = {} as unknown as TDXEnv

type FetchCall = {
  url: URL
  ttlSeconds: number
  options?: TDXResolutionOptions<unknown>
}

function harness(
  responder: (url: URL, options?: TDXResolutionOptions<unknown>) => unknown | Promise<unknown>,
) {
  const calls: FetchCall[] = []
  const fetchTDXJson: TDXBusRouteQueryDependencies['fetchTDXJson'] = async <T>(
    _env: TDXEnv,
    url: URL,
    ttlSeconds: number,
    options?: TDXResolutionOptions<T>,
  ): Promise<T> => {
    calls.push({ url, ttlSeconds, options: options as TDXResolutionOptions<unknown> | undefined })
    return await responder(url, options as TDXResolutionOptions<unknown> | undefined) as T
  }
  return {
    calls,
    queries: createTDXBusRouteQueries({
      fetchTDXJson,
      telemetryCity: (value): TelemetryCity | null => value === 'Taipei' ? 'Taipei' : null,
    }),
  }
}

function group(name: string, subRouteUid: string, stopNames = ['起點', '終點']): StopGroup {
  return {
    direction: 0,
    label: `${stopNames[0]} → ${stopNames.at(-1)}`,
    routeUid: 'R1',
    subRouteUid,
    subRouteName: name,
    stops: stopNames.map((stopName, index): RouteStop => ({
      routeUid: 'R1',
      subRouteUid,
      subRouteName: name,
      stopUid: `${subRouteUid}-${index}`,
      stopName,
      direction: 0,
      sequence: index + 1,
    })),
  }
}

describe('TDX bus route/query boundary', () => {
  it('selects InterCity only for THB route identities and encodes city scope', () => {
    expect(tdxRouteScope('New Taipei', 'THB123')).toBe('InterCity')
    expect(tdxRouteScope('New Taipei', 'NWT123')).toBe('City/New%20Taipei')
    expect(tdxRouteScope('Taipei')).toBe('City/Taipei')
  })

  it('merges only rows with the same route, subroute, direction and stop sequence', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', 'SUB-1'),
      group('A區間', 'SUB-1'),
      group('B支線', 'SUB-2'),
      group('A改道', 'SUB-1', ['起點', '中間', '終點']),
    ])

    expect(merged).toHaveLength(3)
    expect(merged[0].subRouteName).toBe('A支線／A區間')
    expect(merged.map((item) => item.subRouteUid)).toEqual(['SUB-1', 'SUB-2', 'SUB-1'])
  })

  it('falls back from an empty City StopOfRoute result and preserves circular direction 2', async () => {
    const { calls, queries } = harness((url) => {
      if (url.pathname.includes('/StopOfRoute/City/')) return []
      return [{
        RouteUID: 'THB9001',
        RouteName: { Zh_tw: '9001' },
        SubRouteUID: 'THB9001-A',
        Direction: 2,
        Stops: [
          { StopUID: 'S2', StopName: { Zh_tw: '第二站' }, StopSequence: 2 },
          {
            StopUID: 'S1',
            StopName: { Zh_tw: '第一站' },
            StopSequence: 1,
            StopPosition: { PositionLat: 25, PositionLon: 121 },
          },
        ],
      }]
    })

    const groups = await queries.getRouteStopGroups(env, 'Taipei', '9001')

    expect(calls).toHaveLength(2)
    expect(calls[0].url.pathname).toContain('/StopOfRoute/City/Taipei/9001')
    expect(calls[1].url.pathname).toContain('/StopOfRoute/InterCity/9001')
    expect(calls.every((call) => call.url.searchParams.get('$format') === 'JSON')).toBe(true)
    expect(groups[0]).toMatchObject({
      direction: 2,
      routeUid: 'THB9001',
      subRouteUid: 'THB9001-A',
      label: '第一站 → 第二站',
    })
    expect(groups[0].stops.map((stop) => stop.stopUid)).toEqual(['S1', 'S2'])
    expect(groups[0].stops[0].position).toEqual({ latitude: 25, longitude: 121 })
  })

  it('resolves a shared stop through the requested subroute and reports ambiguity otherwise', async () => {
    const rows = [
      {
        RouteUID: 'R1', RouteName: { Zh_tw: '307' }, SubRouteUID: 'SUB-A', Direction: 0,
        Stops: [{ StopUID: 'STOP-A', StopName: { Zh_tw: '共同站' }, StopSequence: 1 }],
      },
      {
        RouteUID: 'R1', RouteName: { Zh_tw: '307' }, SubRouteUID: 'SUB-B', Direction: 0,
        Stops: [{ StopUID: 'STOP-B', StopName: { Zh_tw: '共同站' }, StopSequence: 1 }],
      },
    ]
    const { queries } = harness(() => rows)

    await expect(queries.resolveBusQuery(env, {
      city: 'Taipei', routeName: '307', stopName: '共同站', subRouteUid: 'SUB-B', direction: 0,
    })).resolves.toMatchObject({
      routeUid: 'R1', subRouteUid: 'SUB-B', stopUid: 'STOP-B', stopName: '共同站',
    })

    await expect(queries.resolveBusQuery(env, {
      city: 'Taipei', routeName: '307', stopName: '共同站', direction: 0,
    })).rejects.toMatchObject({
      name: 'QueryResolutionError',
      message: '找到多個同名站牌，請選擇正確站牌',
      candidates: expect.arrayContaining([
        expect.objectContaining({ stopUid: 'STOP-A' }),
        expect.objectContaining({ stopUid: 'STOP-B' }),
      ]),
    })
  })

  it('keeps the exact not-found query error', async () => {
    const { queries } = harness(() => [])
    await expect(queries.resolveBusQuery(env, {
      city: 'Taipei', routeName: '307', stopName: '不存在', direction: 0,
    })).rejects.toEqual(new QueryResolutionError('找不到 307 的 不存在'))
  })

  it('maps, deduplicates and numerically sorts the city route catalog with telemetry policy', async () => {
    const { calls, queries } = harness(() => [
      { RouteUID: 'R10', RouteName: { Zh_tw: '10' }, DepartureStopNameZh: '甲', DestinationStopNameZh: '乙' },
      { RouteUID: 'R2', RouteName: { Zh_tw: '2' }, DepartureStopNameZh: '丙', DestinationStopNameZh: '丁' },
      { RouteUID: 'R2', RouteName: { Zh_tw: '重複' } },
      { RouteUID: 'MISSING' },
    ])

    const routes = await queries.getRouteCatalog(env, 'Taipei')

    expect(routes.map((route) => route.routeName)).toEqual(['2', '10'])
    expect(routes[0]).toMatchObject({ routeUid: 'R2', category: '數字', departure: '丙', destination: '丁' })
    expect(calls[0].url.pathname).toContain('/Route/City/Taipei')
    expect(calls[0].options).toMatchObject({ operation: 'route_catalog', city: 'Taipei' })
    expect(calls[0].options?.validate?.([{}])).toBe(true)
    expect(calls[0].options?.validate?.([null])).toBe(false)
  })

  it('keeps suggestions within 25 metres, joins city/intercity direction labels and deduplicates', async () => {
    const { queries } = harness((url) => {
      const path = url.pathname
      if (path.includes('/EstimatedTimeOfArrival/City/')) return [
        {
          RouteUID: 'R307', RouteName: { Zh_tw: '307' }, SubRouteUID: 'R307-A',
          StopUID: 'CITY-A', StopName: { Zh_tw: '共同站' }, Direction: 0, EstimateTime: 120,
        },
        {
          RouteUID: 'R999', RouteName: { Zh_tw: '999' },
          StopUID: 'CITY-FAR', StopName: { Zh_tw: '共同站' }, Direction: 0, EstimateTime: 300,
        },
      ]
      if (path.includes('/Stop/City/')) return [
        { StopUID: 'CITY-A', StopPosition: { PositionLat: 25, PositionLon: 121 } },
        { StopUID: 'CITY-FAR', StopPosition: { PositionLat: 25.001, PositionLon: 121 } },
      ]
      if (path.includes('/Route/City/')) return [
        { RouteUID: 'R307', RouteName: { Zh_tw: '307' }, DepartureStopNameZh: '板橋', DestinationStopNameZh: '撫遠街' },
      ]
      if (path.includes('/EstimatedTimeOfArrival/InterCity')) return [
        {
          RouteUID: 'THB9001', RouteName: { Zh_tw: '9001' }, SubRouteUID: 'THB9001-A',
          StopUID: 'IC-NEAR', StopName: { Zh_tw: '共同站' }, Direction: 1, EstimateTime: -30,
        },
      ]
      if (path.includes('/Stop/InterCity')) return [
        { StopUID: 'IC-NEAR', StopPosition: { PositionLat: 25.0001, PositionLon: 121 } },
      ]
      if (path.includes('/Route/InterCity')) return [
        { RouteUID: 'THB9001', RouteName: { Zh_tw: '9001' }, DepartureStopNameZh: '台北', DestinationStopNameZh: '基隆' },
      ]
      throw new Error(`unexpected URL ${url}`)
    })

    const suggestions = await queries.getStopRouteSuggestions(env, 'Taipei', "共同'站", 'CITY-A')

    expect(suggestions.map((item) => item.stopUid)).toEqual(['CITY-A', 'IC-NEAR'])
    expect(suggestions[0]).toMatchObject({ routeName: '307', directionLabel: '板橋 → 撫遠街', label: '2 分' })
    expect(suggestions[1]).toMatchObject({ routeName: '9001', directionLabel: '基隆 → 台北', label: '即將進站' })
  })

  it('fails open when all InterCity suggestion resources are unavailable', async () => {
    const { queries } = harness((url) => {
      const path = url.pathname
      if (path.includes('/InterCity')) throw new Error('intercity unavailable')
      if (path.includes('/EstimatedTimeOfArrival/City/')) return [{
        RouteUID: 'R1', RouteName: { Zh_tw: '1' }, StopUID: 'CITY-A',
        StopName: { Zh_tw: '共同站' }, Direction: 0, EstimateTime: 60,
      }]
      if (path.includes('/Stop/City/')) return [{
        StopUID: 'CITY-A', StopPosition: { PositionLat: 25, PositionLon: 121 },
      }]
      if (path.includes('/Route/City/')) return [{
        RouteUID: 'R1', RouteName: { Zh_tw: '1' }, DepartureStopNameZh: '甲', DestinationStopNameZh: '乙',
      }]
      return []
    })

    await expect(queries.getStopRouteSuggestions(env, 'Taipei', '共同站', 'CITY-A')).resolves.toEqual([
      expect.objectContaining({ routeName: '1', stopUid: 'CITY-A', directionLabel: '甲 → 乙' }),
    ])
  })
})
