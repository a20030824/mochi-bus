import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from './bus-query'
import {
  QueryResolutionError,
  TDXServiceError,
  type RouteDetail,
  type StopGroup,
  type TDXEnv,
} from '../lib/tdx'
import type { ScheduleItem } from './schedule'
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

const fullyRealtimeDetail: RouteDetail = {
  ...realtimeDetail,
  stops: realtimeDetail.stops.map((stop, index) => index === 2
    ? { ...stop, etaLabel: '18 分', etaTone: 'live' }
    : stop),
}

const env: TDXEnv = {
  TDX_CLIENT_ID: 'client',
  TDX_CLIENT_SECRET: 'secret',
}

const now = () => new Date('2026-07-20T05:20:00.000Z') // Monday 13:20 in Taipei

function exactSchedule(stopUid: string, arrivalTime: string): ScheduleItem[] {
  return [{
    SubRouteUID: 'TPE307-0',
    Direction: 0,
    Timetables: [{
      ServiceDay: { Monday: 1 },
      StopTimes: [{ StopUID: stopUid, StopSequence: 2, ArrivalTime: arrivalTime }],
    }],
  }]
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
    expect(detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
  })

  it('fails closed when station order does not match the requested route pattern', async () => {
    await expect(getRoutePageDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [{ ...group, subRouteUid: 'OTHER' }]),
    })).rejects.toBeInstanceOf(QueryResolutionError)
  })
})

describe('getRouteEtaDetail', () => {
  it('does not load timetable or separate static station order when every row has realtime ETA', async () => {
    const getRouteStopGroups = vi.fn(async () => [group])
    const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])
    const getRouteDetail = vi.fn(async () => fullyRealtimeDetail)

    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups,
      getRouteDetail,
      getBusSchedule,
      now,
    })

    expect(getRouteDetail).toHaveBeenCalledOnce()
    expect(getBusSchedule).not.toHaveBeenCalled()
    expect(getRouteStopGroups).not.toHaveBeenCalled()
    expect(result).toEqual({ detail: fullyRealtimeDetail, eta: { kind: 'realtime' } })
  })

  it('fills a missing row with its exact stop-level timetable time', async () => {
    const getRouteStopGroups = vi.fn(async () => [group])
    const getBusSchedule = vi.fn(async () => exactSchedule('TPE3', '13:45'))

    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups,
      getRouteDetail: vi.fn(async () => realtimeDetail),
      getBusSchedule,
      now,
    })

    expect(getBusSchedule).toHaveBeenCalledOnce()
    expect(getRouteStopGroups).not.toHaveBeenCalled()
    expect(result.eta).toEqual({ kind: 'realtime' })
    expect(result.detail.stops[2]).toMatchObject({ etaLabel: '表定 13:45', etaTone: 'muted' })
  })

  it('preserves a selected stop timetable when realtime has no ETA', async () => {
    const emptyDetail: RouteDetail = {
      ...realtimeDetail,
      stops: realtimeDetail.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted' })),
    }
    const getRouteStopGroups = vi.fn(async () => [group])

    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups,
      getRouteDetail: vi.fn(async () => emptyDetail),
      getBusSchedule: vi.fn(async () => exactSchedule('TPE2', '13:40')),
      now,
    })

    expect(getRouteStopGroups).not.toHaveBeenCalled()
    expect(result.eta).toEqual({ kind: 'empty' })
    expect(result.detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '表定 13:40',
      etaTone: 'muted',
    })
    expect(result.detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
  })

  it('uses a selected status and dashes when no exact stop timetable is available', async () => {
    const emptyDetail: RouteDetail = {
      ...realtimeDetail,
      stops: realtimeDetail.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted' })),
    }
    const departureOnly: ScheduleItem[] = [{
      SubRouteUID: 'TPE307-0',
      Direction: 0,
      Timetables: [{
        ServiceDay: { Monday: 1 },
        StopTimes: [{ StopUID: 'ORIGIN', StopSequence: 1, DepartureTime: '13:30' }],
      }],
    }]

    const result = await getRouteEtaDetail(env, query, {
      getRouteDetail: vi.fn(async () => emptyDetail),
      getBusSchedule: vi.fn(async () => departureOnly),
      now,
    })

    expect(result.eta).toEqual({ kind: 'empty' })
    expect(result.detail.stops.find((stop) => stop.selected)?.etaLabel).toBe('暫無即時')
    expect(result.detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
  })

  it('keeps realtime rows and converts gaps to dashes when timetable loading fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await getRouteEtaDetail(env, query, {
      getRouteDetail: vi.fn(async () => realtimeDetail),
      getBusSchedule: vi.fn(async () => { throw new TDXServiceError('schedule unavailable', 503) }),
      now,
    })

    expect(result.eta).toEqual({ kind: 'realtime' })
    expect(result.detail.stops[0].etaLabel).toBe('12 分')
    expect(result.detail.stops[2].etaLabel).toBe('—')
    expect(console.error).toHaveBeenCalledWith(JSON.stringify({
      message: 'route_schedule_fallback_failed',
      city: 'Taipei',
    }))
  })

  it('loads static station order only after realtime ETA is rate limited', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TDXServiceError('rate limited', 429)
    const calls: string[] = []
    const getBusSchedule = vi.fn(async () => [] as ScheduleItem[])
    const result = await getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => { calls.push('groups'); return [group] }),
      getRouteDetail: vi.fn(async () => { calls.push('detail'); throw error }),
      getBusSchedule,
      now,
    })

    expect(calls).toEqual(['detail', 'groups'])
    expect(getBusSchedule).not.toHaveBeenCalled()
    expect(result.eta).toEqual({ kind: 'unavailable', warning: 'tdx-rate-limit' })
    expect(result.detail.stops.map((stop) => stop.stopUid)).toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(result.detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '即時忙線',
      etaTone: 'muted',
    })
    expect(result.detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
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
      now,
    })

    expect(result.detail.stops.find((stop) => stop.selected)?.etaLabel).toBe('額度不可用')
    expect(result.eta).toEqual({ kind: 'unavailable', warning: 'tdx-quota' })
  })

  it('does not hide a rejected user token or load fallback station order', async () => {
    const error = new TDXServiceError('token rejected', 401)
    const getRouteStopGroups = vi.fn(async () => [group])
    await expect(getRouteEtaDetail({ ...env, TDX_USER_ACCESS_TOKEN: 'user-token' }, query, {
      getRouteStopGroups,
      getRouteDetail: vi.fn(async () => { throw error }),
      now,
    })).rejects.toBe(error)
    expect(getRouteStopGroups).not.toHaveBeenCalled()
  })

  it('propagates a rejected user token from timetable fallback', async () => {
    const error = new TDXServiceError('token rejected', 401)
    const getRouteStopGroups = vi.fn(async () => [group])
    await expect(getRouteEtaDetail({ ...env, TDX_USER_ACCESS_TOKEN: 'user-token' }, query, {
      getRouteStopGroups,
      getRouteDetail: vi.fn(async () => realtimeDetail),
      getBusSchedule: vi.fn(async () => { throw error }),
      now,
    })).rejects.toBe(error)
    expect(getRouteStopGroups).not.toHaveBeenCalled()
  })

  it('does not convert programming errors into a fake TDX warning or fallback lookup', async () => {
    const error = new TypeError('broken mapper')
    const getRouteStopGroups = vi.fn(async () => [group])
    await expect(getRouteEtaDetail(env, query, {
      getRouteStopGroups,
      getRouteDetail: vi.fn(async () => { throw error }),
      now,
    })).rejects.toBe(error)
    expect(getRouteStopGroups).not.toHaveBeenCalled()
  })

  it('fails closed when fallback station groups cannot identify the requested pattern', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = new TDXServiceError('unavailable', 503)
    await expect(getRouteEtaDetail(env, query, {
      getRouteStopGroups: vi.fn(async () => [{ ...group, subRouteUid: 'OTHER' }]),
      getRouteDetail: vi.fn(async () => { throw error }),
      now,
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
