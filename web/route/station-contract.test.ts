import { describe, expect, it } from 'vitest'
import {
  hasStrictlyIncreasingRouteSequence,
  parseRouteStationBase,
  parseRouteStationEnvelope,
  ROUTE_STATION_LIMITS,
} from './station-contract'

const station = {
  stopUid: 'TPE1',
  stopName: '板橋公車站',
  sequence: 1,
}

describe('Route station contract', () => {
  it('accepts the shared versioned envelope bounds', () => {
    const stops = Array.from({ length: ROUTE_STATION_LIMITS.maxStops }, (_, index) => ({
      ...station,
      stopUid: `TPE${index}`,
      sequence: index,
    }))

    expect(parseRouteStationEnvelope({ schemaVersion: 1, stops })?.stops).toHaveLength(1_000)
  })

  it.each([
    null,
    { schemaVersion: 2, stops: [station] },
    { schemaVersion: 1, stops: [] },
    { schemaVersion: 1, stops: Array.from({ length: 1_001 }, () => station) },
  ])('rejects an invalid shared envelope %#', (value) => {
    expect(parseRouteStationEnvelope(value)).toBeNull()
  })

  it('accepts the canonical UID, name, and safe sequence limits', () => {
    expect(parseRouteStationBase({
      stopUid: 'u'.repeat(ROUTE_STATION_LIMITS.maxStopUidLength),
      stopName: '站'.repeat(ROUTE_STATION_LIMITS.maxStopNameLength),
      sequence: Number.MAX_SAFE_INTEGER,
    })).not.toBeNull()
  })

  it.each([
    { ...station, stopUid: '' },
    { ...station, stopUid: 'u'.repeat(129) },
    { ...station, stopName: '' },
    { ...station, stopName: '站'.repeat(257) },
    { ...station, sequence: -1 },
    { ...station, sequence: 1.5 },
    { ...station, sequence: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects an invalid base station %#', (value) => {
    expect(parseRouteStationBase(value)).toBeNull()
  })

  it('requires strictly increasing station sequence', () => {
    expect(hasStrictlyIncreasingRouteSequence([
      station,
      { ...station, stopUid: 'TPE2', sequence: 2 },
    ])).toBe(true)
    expect(hasStrictlyIncreasingRouteSequence([
      station,
      { ...station, stopUid: 'TPE2', sequence: 1 },
    ])).toBe(false)
  })
})
