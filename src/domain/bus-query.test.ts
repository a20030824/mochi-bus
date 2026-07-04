import { describe, expect, it } from 'vitest'
import {
  canonicalBusPath,
  parseBusQuery,
  QueryValidationError,
  toBusSearchParams,
} from './bus-query'

const cities = new Set(['Taipei', 'NewTaipei'])

describe('parseBusQuery', () => {
  it('rejects JavaScript null-like strings as missing stop values', () => {
    expect(() => parseBusQuery({
      city: 'Chiayi',
      route: '中山幹線(綠線)',
      stop: 'undefined',
      stopUid: 'undefined',
      direction: '0',
    }, undefined, new Set(['Chiayi']))).toThrow(QueryValidationError)
  })
  it('parses a human-readable bus query', () => {
    expect(parseBusQuery({
      city: 'Taipei',
      route: '307',
      stop: '捷運西門站',
      direction: '0',
    }, undefined, cities)).toEqual({
      city: 'Taipei',
      routeName: '307',
      stopName: '捷運西門站',
      stopUid: undefined,
      routeUid: undefined,
      direction: 0,
    })
  })

  it('accepts StopUID without a stop name', () => {
    const query = parseBusQuery({
      city: 'Taipei',
      route: '307',
      stopUid: 'TPE213044',
      direction: '0',
    }, undefined, cities)

    expect(query.stopUid).toBe('TPE213044')
  })

  it('rejects an invalid direction', () => {
    expect(() => parseBusQuery({
      city: 'Taipei',
      route: '307',
      stop: '捷運西門站',
      direction: '2',
    }, undefined, cities)).toThrow(QueryValidationError)
  })
})

describe('canonical URLs', () => {
  it('keeps stable IDs and human-readable names', () => {
    const query = {
      city: 'Taipei',
      routeName: '307',
      routeUid: 'TPE19108',
      stopName: '捷運西門站',
      stopUid: 'TPE213044',
      direction: 0 as const,
    }

    expect(toBusSearchParams(query).get('stop')).toBe('捷運西門站')
    expect(canonicalBusPath(query)).toContain('stopUid=TPE213044')
  })
})
