import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from './bus-query'
import {
  QueryResolutionError,
  TDXServiceError,
  type RouteDetail,
  type StopGroup,
  type TDXEnv,
} from '../lib/tdx'
import { getRouteEtaDetail, getRoutePageDetail, toRouteEtaResponse } from './route-page-detail'

const query: ResolvedBusQuery = {
  city: 'Taipei',
  routeName: '307',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-0',
  stopName: '捷運西門站',
  stopUid: 'TPE2',
  direction: 0,
}

const group: StopGroup = {
  direction: 0,
  label: '板橋 → 撫遠街',
  routeUid: 'TPE307',
  subRouteUid: 'TPE307-0',
  subRouteName: '307',
  stops: [
    { routeUid: 'TPE307', subRouteUid: 'TPE307-0', subRouteName: '307', stopUid: 'TPE1', stopName: '板橋公車站', direction: 0, sequence: 1 },
    { routeUid: 'TPE307', subRouteUid: 'TPE307-0', subRouteName: '307', stopUid: 'TPE2', stopName: '捷運西門站', direction: 0, sequence: 2 },
    { routeUid: 'TPE307', subRouteUid: 'TPE307-0', subRouteName: '307', stopUid: 'TPE3', stopName: '撫遠街', direction: 0, sequence: 3 },
  ],
}

const realtimeDetail: RouteDetail = {
  routeName: '307',
  direction: 0,
  label: group.label,
  stops: [
    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: '12 分', etaTone: 'live' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '即將進站', etaTone: 'urgent' },
    { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3, selected: false, etaLabel: null, etaTone: 'muted' },
  ],
}

const env: TDXEnv = {
  TDX_CLIENT_ID: 'client',
  TDX_CLIENT_SECRET: 'secret',
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('getRoutePageDetail', () => {
  it('builds an ETA-free Route shell from one static stop-group lookup', async () => {
    const getRouteStopGroups = vi.fn(async () => [group])

    const { detail } = await getRoutePageDetail(env, query, { getRouteStopGroups })

    expect(getRouteStopGroups).toHaveBeenCalledOnce()
    expect(detail.stops.map((stop) => stop.stopUid)).toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '更新中',
      etaTone: 'muted',
    })
    expect(detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === null)).toBe(true)
  })

  it('fails closed when station order does not match the requested route pattern', async () => {
    await expect(getRoutePageDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [{ ...group, subRouteUid: 'OTHER' }]),
    })).rejects.toBeInstanceOf(QueryResolutionError)
  })
})

describe('getRouteEtaDetail', () => {
  it('resolves station order before realtime detail and preserves successful ETA', async () => {
    const calls: string[] = []
    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => { calls.push('groups'); return [group] }),
      getRouteDetail: vi.fn(async () => { calls.push('detail'); return realtimeDetail }),
    })

    expect(calls).toEqual(['groups', 'detail'])
    expect(result).toEqual({ detail: realtimeDetail, eta: { kind: 'realtime' } })
  })

  it('marks the selected stop when TDX returns no usable ETA information', async () => {
    const emptyDetail: RouteDetail = {
      ...realtimeDetail,
      stops: realtimeDetail.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted' })),
    }
    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [group]),
      getRouteDetail: vi.fn(async () => emptyDetail),
    })

    expect(result.eta).toEqual({ kind: 'empty' })
    expect(result.detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '暫無即時',
      etaTone: 'muted',
    })
    expect(result.detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === null)).toBe(true)
  })

  it('keeps the complete station order when realtime ETA is rate limited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TDXServiceError('rate limited', 429)
    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [group]),
      getRouteDetail: vi.fn(async () => { throw error }),
    })

    expect(result.eta).toEqual({ kind: 'unavailable', warning: 'tdx-rate-limit' })
    expect(result.detail.stops.map((stop) => stop.stopUid)).toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(result.detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '即時忙線',
      etaTone: 'muted',
    })
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      message: 'route_eta_failed',
      city: 'Taipei',
      warning: 'tdx-rate-limit',
    }))
  })

  it('uses the stronger quota wording when TDX identifies exhausted shared quota', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TDXServiceError('quota exhausted', 429)
    error.warning = 'tdx-quota'
    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [group]),
      getRouteDetail: vi.fn(async () => { throw error }),
    })

    expect(result.detail.stops.find((stop) => stop.selected)?.etaLabel).toBe('額度不可用')
    expect(result.eta).toEqual({ kind: 'unavailable', warning: 'tdx-quota' })
  })

  it('does not hide a rejected user token behind route degradation', async () => {
    const error = new TDXServiceError('token rejected', 401)
    await expect(getRouteEtaDetail({ ...env, TDX_USER_ACCESS_TOKEN: 'user-token' }, query, {
      getRouteStopGroups: vi.fn(async () => [group]),
      getRouteDetail: vi.fn(async () => { throw error }),
    })).rejects.toBe(error)
  })

  it('does not convert programming errors into a fake TDX warning', async () => {
    const error = new TypeError('broken mapper')
    await expect(getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [group]),
      getRouteDetail: vi.fn(async () => { throw error }),
    })).rejects.toBe(error)
  })

  it('fails closed when prefetched station groups cannot identify the requested pattern', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TDXServiceError('unavailable', 503)
    await expect(getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [{ ...group, subRouteUid: 'OTHER' }]),
      getRouteDetail: vi.fn(async () => { throw error }),
    })).rejects.toBeInstanceOf(QueryResolutionError)
  })
})

describe('toRouteEtaResponse', () => {
  it('publishes only the ordered ETA contract needed by the browser', () => {
    expect(toRouteEtaResponse({ detail: realtimeDetail, eta: { kind: 'realtime' } })).toEqual({
      schemaVersion: 1,
      eta: { kind: 'realtime' },
      stops: realtimeDetail.stops.map(({ selected: _selected, ...stop }) => stop),
    })
  })
})
