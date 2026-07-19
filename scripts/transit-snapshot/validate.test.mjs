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
  const secondStop = { uid: 'S2', placeId: 'L1', lat: 23.5, lon: 120.5 }
  return {
    city: 'Chiayi', version: 'v1',
    routes: new Map([['R1', route]]),
    patterns: [pattern],
    stops: new Map([['S1', stop], ['S2', secondStop]]),
    places: new Map([['L1', place]]),
    patternStops: [
      { patternId: 'P1', stopUid: 'S1', placeId: 'L1', sequence: 1 },
      { patternId: 'P1', stopUid: 'S2', placeId: 'L1', sequence: 2 },
    ],
    schedules: new Map([['R1', []]]),
    placeBundles: new Map([['L1', {
      version: 'v1', placeId: 'L1',
      routes: [
        { routeUid: 'R1', variantKey: 'P1', stopUid: 'S1', stopSequence: 1, schedules: [] },
        { routeUid: 'R1', variantKey: 'P1', stopUid: 'S2', stopSequence: 2, schedules: [] },
      ],
    }]]),
    network: {
      schemaVersion: 1, city: 'Chiayi', version: 'v1',
      routes: [{ variantKey: 'P1', shape: shapeFeature }],
      places: [{ placeId: 'L1' }],
    },
  }
}

describe('validateSnapshot', () => {
  it('accepts a complete internally consistent snapshot', () => {
    const result = validateSnapshot(validSnapshot())
    expect(result).toMatchObject({
      valid: true,
      counts: { routes: 1, patterns: 1, stops: 2, places: 1, patternStops: 2, schedules: 1, placeBundles: 1 },
      quality: {
        scheduledRoutes: 0,
        scheduleRouteCoverage: 0,
        bundleRoutes: 2,
        bundleRoutesWithSchedules: 0,
        bundleScheduleCoverage: 0,
        networkCoordinates: 2,
      },
    })
    expect(result.quality.networkBytes).toBeGreaterThan(0)
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

  it('rejects catalogue routes that have no pattern', () => {
    const snapshot = validSnapshot()
    snapshot.routes.set('ORPHAN', { uid: 'ORPHAN', name: 'orphan' })
    snapshot.schedules.set('ORPHAN', [])

    expect(() => validateSnapshot(snapshot)).toThrow(/route ORPHAN has no pattern/)
  })

  it('rejects pattern-stop places that differ from the canonical stop', () => {
    const snapshot = validSnapshot()
    snapshot.places.set('L2', { id: 'L2', lat: 23.41, lon: 120.41 })
    snapshot.patternStops[0].placeId = 'L2'

    expect(() => validateSnapshot(snapshot)).toThrow(
      /stop S1 has 1 pattern reference\(s\) to L2, but canonical place is L1/,
    )
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
    expect(() => validateSnapshot(validSnapshot(), {
      counts: { routes: 2 },
    })).toThrow(/routes dropped from 2 to 1/)
  })

  it('requires every pattern to have at least two stops and every bundle entry to be backed by one', () => {
    const snapshot = validSnapshot()
    snapshot.patternStops.pop()
    snapshot.placeBundles.get('L1').routes[0].stopUid = 'S2'

    expect(() => validateSnapshot(snapshot)).toThrow(/has only 1 stop|not backed by a pattern stop/)
  })

  it('blocks catastrophic schedule coverage and network geometry regression', () => {
    expect(() => validateSnapshot(validSnapshot(), {
      counts: { routes: 1, patterns: 1, stops: 2, places: 1, patternStops: 2, placeBundles: 1 },
      quality: {
        bundleRoutes: 2,
        scheduledRoutes: 1,
        bundleRoutesWithSchedules: 1,
        scheduleRouteCoverage: 1,
        bundleScheduleCoverage: 1,
        networkCoordinates: 10,
        networkBytes: 10_000,
      },
    })).toThrow(/scheduledRoutes dropped|scheduleRouteCoverage dropped|networkCoordinates dropped|networkBytes dropped/)
  })
})
