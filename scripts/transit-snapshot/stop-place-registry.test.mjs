import { describe, expect, it } from 'vitest'
import { createStopPlaceRegistry } from './stop-place-registry.mjs'

function normalizeName(value) {
  return value.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase()
    .replaceAll('臺', '台').replace(/火車站|車站/g, '站').replace(/站$/, '')
}

function hash(value) {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return (result >>> 0).toString(36)
}

function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6_371_000
  const radians = (value) => value * Math.PI / 180
  const deltaLat = radians(lat2 - lat1)
  const deltaLon = radians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function observation({ uid = 'TAO1054', name = '桃園站', lat = 24.989, lon = 121.313, sequence = 1 } = {}) {
  return {
    StopUID: uid,
    StopName: { Zh_tw: name },
    StopPosition: { PositionLat: lat, PositionLon: lon },
    StopSequence: sequence,
  }
}

function registry() {
  return createStopPlaceRegistry({ city: 'Taoyuan', normalizeName, hash, distanceMeters })
}

describe('StopUID canonical stop/place registry', () => {
  it('keeps the first City observation when a later InterCity occurrence differs', () => {
    const value = registry()
    const first = value.addOccurrence({ patternId: 'CITY:0', stop: observation() })
    const later = value.addOccurrence({
      patternId: 'THB:0',
      stop: observation({ name: '桃園火車站', lat: 24.9915, lon: 121.3155 }),
    })

    expect(later).toBe(first)
    expect(value.stops.get('TAO1054')).toMatchObject({
      name: '桃園站', lat: 24.989, lon: 121.313, placeId: first.placeId,
    })
    expect(value.patternStops.map((item) => item.placeId)).toEqual([first.placeId, first.placeId])
    expect(value.places.size).toBe(1)
    expect(value.duplicateWarnings()).toEqual([expect.objectContaining({
      stopUid: 'TAO1054', occurrences: 2, canonicalPlaceId: first.placeId,
      maxDistanceMeters: expect.any(Number),
    })])
  })

  it('reuses one canonical place across eight pattern occurrences', () => {
    const value = registry()
    for (let index = 0; index < 8; index += 1) {
      value.addOccurrence({
        patternId: `P${index}`,
        stop: observation({ sequence: index + 1, lat: 24.989 + index * 0.00001 }),
      })
    }
    const placeIds = new Set(value.patternStops.map((item) => item.placeId))
    expect(placeIds.size).toBe(1)
    expect(value.stops.size).toBe(1)
    expect(value.places.size).toBe(1)
  })

  it('does not create an orphan place for a duplicate StopUID', () => {
    const value = registry()
    const first = value.addOccurrence({ patternId: 'P1', stop: observation() })
    value.addOccurrence({
      patternId: 'P2',
      stop: observation({ name: '完全不同站名', lat: 25.2, lon: 121.6 }),
    })
    expect([...value.places.keys()]).toEqual([first.placeId])
  })

  it('retains nearby same-name clustering for distinct StopUIDs', () => {
    const value = registry()
    const first = value.addOccurrence({ patternId: 'P1', stop: observation({ uid: 'S1' }) })
    const second = value.addOccurrence({
      patternId: 'P2',
      stop: observation({ uid: 'S2', lat: 24.9892, lon: 121.3132 }),
    })
    expect(second.placeId).toBe(first.placeId)
    expect(value.stops.size).toBe(2)
    expect(value.places.size).toBe(1)
  })
})
