import { describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../../domain/bus-query'
import type { ScheduleItem } from '../../domain/schedule'
import type { StopGroup } from './bus-route-queries'
import {
  createTDXCommuteRoutePresentation,
  type TDXCommuteRoutePresentationDependencies,
} from './commute-route-presentation'
import { TDXServiceError } from './error-classification'
import type { TDXEnv, TDXResolutionOptions } from './resolution-cache'

const query = {
  city: 'Taipei',
  routeName: '307',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  stopName: '共同站',
  stopUid: 'STOP-2',
  direction: 0,
} satisfies ResolvedBusQuery

const group: StopGroup = {
  direction: 0,
  label: '起點 → 終點',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-A',
  subRouteName: '307',
  stops: [
    {
      routeUid: 'TPE307', subRouteUid: 'TPE307-A', subRouteName: '307',
      stopUid: 'STOP-1', stopName: '起點', direction: 0, sequence: 1,
    },
    {
      routeUid: 'TPE307', subRouteUid: 'TPE307-A', subRouteName: '307',
      stopUid: 'STOP-2', stopName: '共同站', direction: 0, sequence: 2,
    },
  ],
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

describe('TDX route-detail degraded concurrency', () => {
  it('waits for station-order resolution before surfacing a concurrent ETA failure', async () => {
    const stationOrder = deferred<StopGroup[]>()
    const etaFailure = new TDXServiceError('rate limited', 429)
    etaFailure.warning = 'tdx-rate-limit'

    const fetchTDXJson = vi.fn(async <T>(
      _env: TDXEnv,
      _url: URL,
      _ttlSeconds: number,
      _options?: TDXResolutionOptions<T>,
    ): Promise<T> => { throw etaFailure }) as TDXCommuteRoutePresentationDependencies['fetchTDXJson']
    const getRouteStopGroups = vi.fn(() => stationOrder.promise)
    const presentation = createTDXCommuteRoutePresentation({
      fetchTDXJson,
      getRouteStopGroups,
      getBusSchedule: vi.fn(async () => [] as ScheduleItem[]),
      getSnapshotSchedule: vi.fn(async () => null),
    })

    let settled = false
    const result = presentation.getRouteDetail({} as TDXEnv, query)
      .then(
        () => ({ status: 'fulfilled' as const }),
        (reason: unknown) => ({ status: 'rejected' as const, reason }),
      )
      .finally(() => { settled = true })

    await vi.waitFor(() => expect(fetchTDXJson).toHaveBeenCalledOnce())
    await Promise.resolve()
    expect(settled).toBe(false)

    stationOrder.resolve([group])
    await expect(result).resolves.toEqual({ status: 'rejected', reason: etaFailure })
    expect(getRouteStopGroups).toHaveBeenCalledOnce()
  })
})
