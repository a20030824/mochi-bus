import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { buildCandidatePartitions, decodePolyline } from './build-candidates.mjs'

const fixtureUrl = new URL('./fixtures/sanitized-raw-bundle.json', import.meta.url)
const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'))

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value)) deepFreeze(child)
  }
  return value
}

function reverseInputs(bundle) {
  return {
    ...bundle,
    sources: [...bundle.sources].reverse().map((source) => ({
      ...source,
      stopOfRoute: [...source.stopOfRoute].reverse(),
      shapes: [...source.shapes].reverse(),
    })),
  }
}

describe('raw TDX candidate builder', () => {
  it('preserves all patterns and Shapes in RouteUID + Direction partitions', () => {
    const result = buildCandidatePartitions(deepFreeze(structuredClone(fixture)))
    const partition = result.partitions.find((entry) => entry.routeUid === 'TPE-TEST' && entry.direction === 0)
    expect(partition.patterns).toHaveLength(2)
    expect(partition.shapes).toHaveLength(2)
    expect(partition.stats.candidateMultiplicity).toBe(4)
    expect(partition.patterns.map((entry) => entry.subRouteUid)).toEqual(['TPE-TEST-A', 'TPE-TEST-B'])
  })

  it('keeps City and InterCity scopes separate even when identities collide', () => {
    const collision = structuredClone(fixture)
    collision.sources[1].stopOfRoute[0].RouteUID = 'TPE-TEST'
    collision.sources[1].shapes[0].RouteUID = 'TPE-TEST'
    const result = buildCandidatePartitions(collision)
    expect(result.partitions.filter((entry) => entry.routeUid === 'TPE-TEST')).toHaveLength(2)
    expect(new Set(result.partitions.filter((entry) => entry.routeUid === 'TPE-TEST').map((entry) => entry.sourceScope)))
      .toEqual(new Set(['city', 'intercity']))
  })

  it('is deterministic under input permutation and never index-pairs candidates', () => {
    const first = buildCandidatePartitions(structuredClone(fixture))
    const second = buildCandidatePartitions(reverseInputs(structuredClone(fixture)))
    expect(second).toEqual(first)
    const partition = first.partitions.find((entry) => entry.routeUid === 'TPE-TEST')
    expect(partition.patterns.every((pattern) => !pattern.patternId.endsWith(':0'))).toBe(true)
    expect(partition.shapes.every((shape) => !shape.shapeId.endsWith(':0'))).toBe(true)
  })

  it('retains duplicate and contradictory complete identities as diagnostics', () => {
    const input = structuredClone(fixture)
    input.sources[0].stopOfRoute.push(structuredClone(input.sources[0].stopOfRoute[0]))
    input.sources[0].shapes[1].SubRouteUID = 'TPE-TEST-C'
    const partition = buildCandidatePartitions(input).partitions.find((entry) => entry.routeUid === 'TPE-TEST')
    expect(partition.stats.duplicateIdentityCount).toBeGreaterThan(0)
    expect(partition.stats.contradictoryIdentityCount).toBeGreaterThan(0)
  })

  it('preserves invalid coordinates for fail-closed matcher rejection', () => {
    const input = structuredClone(fixture)
    input.sources[0].shapes.push({ RouteUID: 'TPE-TEST', Direction: 0, EncodedPolyline: '?' })
    const partition = buildCandidatePartitions(input).partitions.find((entry) => entry.routeUid === 'TPE-TEST')
    expect(partition.shapes.some((shape) => shape.measurement.decodeFailure)).toBe(true)
  })

  it('decodes TDX encoded polylines without silently accepting truncation', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [-120.2, 38.5], [-120.95, 40.7], [-126.453, 43.252],
    ])
    expect(() => decodePolyline('_')).toThrow()
  })
})
