import { describe, expect, it } from 'vitest'
import { buildStopArrivalBatches, isStopArrivalBatchPayload } from './stop-arrivals'

describe('stop arrival TDX batches', () => {
  it('groups city candidates into one deterministic StopUID and RouteUID query', () => {
    const [batch] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE2', routeName: '299', stopUid: 'STOP2' },
      { routeUid: 'TPE1', routeName: '307', stopUid: 'STOP1' },
      { routeUid: 'TPE3', routeName: '藍1', stopUid: 'STOP1' },
    ])

    expect(batch.scope).toBe('City/Taipei')
    expect(batch.stopUids).toEqual(['STOP1', 'STOP2'])
    expect(batch.candidates).toHaveLength(3)
    expect(batch.url.pathname).toBe('/api/basic/v2/Bus/EstimatedTimeOfArrival/City/Taipei')
    expect(batch.url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP1' or StopUID eq 'STOP2') and (RouteUID eq 'TPE1' or RouteUID eq 'TPE2' or RouteUID eq 'TPE3')",
    )
    expect(batch.url.searchParams.get('$select')).toBe(
      'RouteUID,SubRouteUID,StopUID,Direction,EstimateTime,StopStatus',
    )
    expect(batch.url.searchParams.get('$format')).toBe('JSON')
  })

  it('separates city and intercity scopes and keeps city first', () => {
    const batches = buildStopArrivalBatches('Taipei', [
      { routeUid: 'THB1001', routeName: '國道客運', stopUid: 'THB_STOP' },
      { routeUid: 'TPE1', routeName: '307', stopUid: 'CITY_STOP' },
    ])

    expect(batches.map((batch) => batch.scope)).toEqual(['City/Taipei', 'InterCity'])
    expect(batches.map((batch) => batch.stopUids)).toEqual([['CITY_STOP'], ['THB_STOP']])
    expect(new Set(batches.map((batch) => batch.cacheKey)).size).toBe(2)
  })

  it('chunks oversized StopUID sets without duplicating candidates', () => {
    const batches = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
      { routeUid: 'TPE2', routeName: '2', stopUid: 'STOP2' },
      { routeUid: 'TPE3', routeName: '3', stopUid: 'STOP3' },
    ], 2)

    expect(batches.map((batch) => batch.stopUids)).toEqual([['STOP1', 'STOP2'], ['STOP3']])
    expect(batches.flatMap((batch) => batch.candidates).map((candidate) => candidate.routeUid).sort())
      .toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(batches[0].url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP1' or StopUID eq 'STOP2') and (RouteUID eq 'TPE1' or RouteUID eq 'TPE2')",
    )
    expect(batches[1].url.searchParams.get('$filter')).toBe(
      "(StopUID eq 'STOP3') and (RouteUID eq 'TPE3')",
    )
  })

  it('changes the cache identity when the candidate RouteUID set changes', () => {
    const [wide] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
      { routeUid: 'TPE2', routeName: '2', stopUid: 'STOP1' },
    ])
    const [narrow] = buildStopArrivalBatches('Taipei', [
      { routeUid: 'TPE1', routeName: '1', stopUid: 'STOP1' },
    ])

    expect(wide.cacheKey).not.toBe(narrow.cacheKey)
  })

  it('accepts only bounded, attributable records for requested StopUIDs', () => {
    expect(isStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      SubRouteUID: 'TPE1-0',
      StopUID: 'STOP1',
      Direction: 0,
      EstimateTime: 120,
      StopStatus: 0,
    }], ['STOP1'])).toBe(true)

    expect(isStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      SubRouteUID: null,
      StopUID: 'STOP1',
      Direction: 2,
      EstimateTime: null,
      StopStatus: null,
    }], ['STOP1'])).toBe(true)

    expect(isStopArrivalBatchPayload([{
      StopUID: 'STOP1',
      Direction: 0,
    }], ['STOP1'])).toBe(false)

    expect(isStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      StopUID: 'STOP1',
      Direction: 9,
    }], ['STOP1'])).toBe(false)

    expect(isStopArrivalBatchPayload([{
      RouteUID: 'TPE1',
      StopUID: 'OTHER_STOP',
      Direction: 0,
    }], ['STOP1'])).toBe(false)

    expect(isStopArrivalBatchPayload(Array.from({ length: 501 }, () => ({
      RouteUID: 'TPE1',
      StopUID: 'STOP1',
      Direction: 0,
    })), ['STOP1'])).toBe(false)
  })
})
