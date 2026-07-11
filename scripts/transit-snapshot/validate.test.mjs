import { describe, expect, it } from 'vitest'
import { SnapshotValidationError, validateSnapshot } from './validate.mjs'

function validSnapshot() {
  const shapeFeature = {
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: [[120.4, 23.4], [120.5, 23.5]] },
  }
  const route = { uid: 'R1', name: '1' }
  const pattern = { id: 'P1', routeUid: 'R1', shapeFeature }
  const place = { id: 'L1', lat: 23.4, lon: 120.4 }
  const stop = { uid: 'S1', placeId: 'L1', lat: 23.4, lon: 120.4 }
  return {
    city: 'Chiayi', version: 'v1',
    routes: new Map([['R1', route]]),
    patterns: [pattern],
    stops: new Map([['S1', stop]]),
    places: new Map([['L1', place]]),
    patternStops: [{ patternId: 'P1', stopUid: 'S1', placeId: 'L1', sequence: 1 }],
    schedules: new Map([['R1', []]]),
    placeBundles: new Map([['L1', { routes: [{ routeUid: 'R1' }] }]]),
    network: {
      schemaVersion: 1, city: 'Chiayi', version: 'v1',
      routes: [{ variantKey: 'P1', shape: shapeFeature }],
      places: [{ placeId: 'L1' }],
    },
  }
}

describe('validateSnapshot', () => {
  it('accepts a complete internally consistent snapshot', () => {
    expect(validateSnapshot(validSnapshot())).toEqual({
      valid: true,
      counts: { routes: 1, patterns: 1, stops: 1, places: 1, patternStops: 1, schedules: 1, placeBundles: 1 },
    })
  })

  it('rejects dangling route, stop, place and network references', () => {
    const snapshot = validSnapshot()
    snapshot.patterns[0].routeUid = 'MISSING'
    snapshot.patternStops[0].stopUid = 'MISSING'
    snapshot.stops.get('S1').placeId = 'MISSING'
    snapshot.network.routes[0].variantKey = 'MISSING'

    expect(() => validateSnapshot(snapshot)).toThrow(SnapshotValidationError)
    expect(() => validateSnapshot(snapshot)).toThrow(/references missing route|references missing stop|references missing place|network references missing pattern/)
  })

  it('rejects empty or geographically invalid data', () => {
    const snapshot = validSnapshot()
    snapshot.patterns = []
    snapshot.stops.get('S1').lat = 0
    expect(() => validateSnapshot(snapshot)).toThrow(/patterns must not be empty|invalid Taiwan coordinate/)
  })

  it('blocks catastrophic count regression against the previous published state', () => {
    expect(() => validateSnapshot(validSnapshot(), {
      counts: { routes: 10, patterns: 1, stops: 1, places: 1 },
    })).toThrow(/routes dropped from 10 to 1/)
  })
})
