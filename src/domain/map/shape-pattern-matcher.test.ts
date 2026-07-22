import { describe, expect, it } from 'vitest'
import {
  allDuplicateShape,
  coordinate,
  correctLoopPattern,
  correctShortLoop,
  invalidCoordinateShape,
  meters,
  openDirectionTwoShape,
  pattern,
  reviewMatrixPatterns,
  reviewMatrixShapes,
  segmentProjectionCorrectShape,
  segmentProjectionPattern,
  segmentProjectionWrongShape,
  shape,
  shapeWithConsecutiveDuplicates,
  siblingPatterns,
  siblingShapesWithIdentity,
  siblingShapesWithoutIdentity,
  tinyShapeAt,
  wrongLongDetourLoop,
} from './shape-pattern-matcher.fixtures'
import {
  matchShapesToPatterns,
  type RouteShapeCandidate,
  type ShapePatternCandidate,
  type ShapePatternCoordinate,
} from './shape-pattern-matcher'

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length < 2) return [[...items]]
  return items.flatMap((item, index) => permutations([
    ...items.slice(0, index),
    ...items.slice(index + 1),
  ]).map((tail) => [item, ...tail]))
}

function matchedShapeByPattern(
  patterns: readonly ShapePatternCandidate[],
  shapes: readonly RouteShapeCandidate[],
): Record<string, string> {
  return Object.fromEntries(matchShapesToPatterns(patterns, shapes).matches
    .map((match) => [match.patternId, match.shapeId]))
}

function rotateClosedLoop(
  coordinates: readonly ShapePatternCoordinate[],
  offset: number,
): ShapePatternCoordinate[] {
  const unique = coordinates.slice(0, -1)
  const normalizedOffset = offset % unique.length
  const rotated = [...unique.slice(normalizedOffset), ...unique.slice(0, normalizedOffset)]
  return [...rotated, rotated[0]]
}

function densifyClosedLoop(coordinates: readonly ShapePatternCoordinate[]): ShapePatternCoordinate[] {
  const dense: ShapePatternCoordinate[] = []
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    dense.push(start, [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2])
  }
  dense.push(coordinates.at(-1)!)
  return dense
}

function singlePairCost(patternCandidate: ShapePatternCandidate, shapeCandidate: RouteShapeCandidate): number {
  return matchShapesToPatterns([patternCandidate], [shapeCandidate]).matches[0]?.costMeters ?? Number.POSITIVE_INFINITY
}

describe('shape-to-pattern segment projection', () => {
  it('prefers the long segment containing both stops over a vertex-dense offset sibling', () => {
    const result = matchShapesToPatterns(
      [segmentProjectionPattern],
      [segmentProjectionWrongShape, segmentProjectionCorrectShape],
    )

    expect(result.matches).toEqual([expect.objectContaining({
      patternId: 'SEGMENT-PATTERN',
      shapeId: 'SEGMENT-CORRECT',
      costMeters: 0,
    })])
    expect(singlePairCost(segmentProjectionPattern, segmentProjectionWrongShape)).toBeGreaterThan(100)
  })

  it('matches stops in the middle of a long segment when the polyline is reversed', () => {
    const routePattern = pattern('LONG-MIDDLE', 'ROUTE-LONG', 0, [meters(25, 0), meters(50, 0), meters(75, 0)])
    const reversedShape = shape('LONG-REVERSED', 'ROUTE-LONG', 0, [meters(100, 0), meters(0, 0)])
    const result = matchShapesToPatterns([routePattern], [reversedShape])

    expect(result.matches[0]).toEqual(expect.objectContaining({ shapeId: 'LONG-REVERSED', costMeters: 0 }))
    expect(result.matches[0].metrics?.matchedSpanMeters).toBeCloseTo(50, 1)
  })

  it('uses monotonic segment progress through self-overlap, turnback, and non-consecutive duplicates', () => {
    const routePattern = pattern('TURNBACK', 'ROUTE-TURNBACK', 0, [meters(80, 0), meters(20, 0), meters(-80, 0)])
    const turnbackShape = shape('TURNBACK-SHAPE', 'ROUTE-TURNBACK', 0, [
      meters(0, 0), meters(100, 0), meters(0, 0), meters(-100, 0),
    ])
    const result = matchShapesToPatterns([routePattern], [turnbackShape])

    expect(result.matches[0]).toEqual(expect.objectContaining({ shapeId: 'TURNBACK-SHAPE', costMeters: 0 }))
    expect(result.matches[0].metrics?.matchedSpanMeters).toBeCloseTo(200, 1)
  })
})

describe('Direction 2 arclength coverage', () => {
  it('rejects a partial exact long loop in favor of the complete slightly offset short loop', () => {
    const result = matchShapesToPatterns(
      [correctLoopPattern],
      [wrongLongDetourLoop, correctShortLoop],
    )

    expect(result.matches).toEqual([expect.objectContaining({ shapeId: 'CORRECT-SHORT-LOOP' })])
    expect(singlePairCost(correctLoopPattern, wrongLongDetourLoop))
      .toBeGreaterThan(singlePairCost(correctLoopPattern, correctShortLoop))
    expect(result.matches[0].metrics?.coverageDeficitMeters).toBeGreaterThan(0)
  })

  it('is invariant to loop start coordinate, reverse encoding, and coordinate density', () => {
    const variants = [
      correctShortLoop,
      shape('ROTATED-LOOP', 'ROUTE-LOOP', 2, rotateClosedLoop(correctShortLoop.coordinates, 2)),
      shape('REVERSED-LOOP', 'ROUTE-LOOP', 2, [...correctShortLoop.coordinates].reverse()),
      shape('DENSE-LOOP', 'ROUTE-LOOP', 2, densifyClosedLoop(correctShortLoop.coordinates)),
    ]
    const results = variants.map((candidate) => matchShapesToPatterns([correctLoopPattern], [candidate]).matches[0])

    expect(results.every(Boolean)).toBe(true)
    for (const match of results.slice(1)) {
      expect(match.costMeters).toBeCloseTo(results[0].costMeters!, 1)
      expect(match.metrics?.matchedSpanRatio).toBeCloseTo(results[0].metrics!.matchedSpanRatio, 4)
      expect(match.metrics?.shapeLengthMeters).toBeCloseTo(results[0].metrics!.shapeLengthMeters, 1)
    }
  })

  it('allows one seam crossing but not an open Direction 2 Shape', () => {
    const seamPattern = pattern('SEAM', 'ROUTE-SEAM', 2, [
      meters(0, 100), meters(0, 0), meters(100, 0),
    ])
    const closed = shape('CLOSED-SEAM', 'ROUTE-SEAM', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ])
    const open = shape('OPEN-SEAM', 'ROUTE-SEAM', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 1_000),
    ])
    const result = matchShapesToPatterns([seamPattern], [open, closed])

    expect(result.matches).toEqual([expect.objectContaining({ shapeId: 'CLOSED-SEAM' })])
    expect(result.rejectedShapes).toContainEqual({ shapeId: 'OPEN-SEAM', reason: 'direction-2-not-closed' })
    expect(result.matches[0].metrics?.matchedSpanMeters).toBeLessThanOrEqual(result.matches[0].metrics!.shapeLengthMeters)
  })

  it('fails closed when the only Direction 2 candidate is open', () => {
    const result = matchShapesToPatterns([correctLoopPattern], [openDirectionTwoShape])

    expect(result.matches).toEqual([])
    expect(result.unresolved).toEqual([{
      patternId: 'LOOP',
      reason: 'rejected-or-invalid-shapes',
      candidateShapeIds: [],
    }])
  })
})

describe('global one-to-one assignment', () => {
  it('selects the global cross assignment for the formal 2×2 review matrix', () => {
    const costs = reviewMatrixPatterns.map((patternCandidate) =>
      reviewMatrixShapes.map((shapeCandidate) => singlePairCost(patternCandidate, shapeCandidate)))

    expect(costs[0][0]).toBeCloseTo(86.184, 0)
    expect(costs[0][1]).toBeCloseTo(111.796, 0)
    expect(costs[1][0]).toBeCloseTo(107.917, 0)
    expect(costs[1][1]).toBeCloseTo(301.729, 0)
    expect(matchedShapeByPattern(reviewMatrixPatterns, reviewMatrixShapes)).toEqual({
      P1: 'S2',
      P2: 'S1',
    })
  })

  it('resolves a three-sibling local/global conflict without mutual-best rounds', () => {
    const patterns = [
      ...reviewMatrixPatterns,
      pattern('P3', 'ROUTE-ASSIGN', 0, [meters(1000, 0), meters(1000, 0)]),
    ]
    const shapes = [
      ...reviewMatrixShapes,
      tinyShapeAt('S3', 'ROUTE-ASSIGN', 1000, 0),
    ]

    expect(matchedShapeByPattern(patterns, shapes)).toEqual({ P1: 'S2', P2: 'S1', P3: 'S3' })
  })

  it('keeps all changing edges unresolved when exact best assignments tie', () => {
    const patterns = [
      pattern('A', 'ROUTE-TIE', 0, [meters(0, 0), meters(0, 0)]),
      pattern('B', 'ROUTE-TIE', 0, [meters(0, 0), meters(0, 0)]),
    ]
    const shapes = [tinyShapeAt('X', 'ROUTE-TIE', 0, 0), tinyShapeAt('Y', 'ROUTE-TIE', 0, 0)]
    const result = matchShapesToPatterns(patterns, shapes)

    expect(result.matches).toEqual([])
    expect(result.unresolved).toEqual([
      { patternId: 'A', reason: 'assignment-ambiguous', candidateShapeIds: ['X', 'Y'] },
      { patternId: 'B', reason: 'assignment-ambiguous', candidateShapeIds: ['X', 'Y'] },
    ])
  })

  it('accepts the edge shared by every best assignment and leaves only the swappable remainder unresolved', () => {
    const patterns = [
      pattern('A', 'ROUTE-SHARED', 0, [meters(0, 0), meters(0, 0)]),
      pattern('B', 'ROUTE-SHARED', 0, [meters(0, 0), meters(0, 0)]),
      pattern('FIXED', 'ROUTE-SHARED', 0, [meters(1000, 0), meters(1000, 0)]),
    ]
    const shapes = [
      tinyShapeAt('X', 'ROUTE-SHARED', 0, 0),
      tinyShapeAt('Y', 'ROUTE-SHARED', 0, 0),
      tinyShapeAt('FIXED-SHAPE', 'ROUTE-SHARED', 1000, 0),
    ]
    const result = matchShapesToPatterns(patterns, shapes)

    expect(result.matches).toEqual([expect.objectContaining({ patternId: 'FIXED', shapeId: 'FIXED-SHAPE' })])
    expect(result.unresolved.map(({ patternId, reason }) => ({ patternId, reason }))).toEqual([
      { patternId: 'A', reason: 'assignment-ambiguous' },
      { patternId: 'B', reason: 'assignment-ambiguous' },
    ])
  })

  it('prioritizes maximum cardinality over a cheaper one-pair local result', () => {
    const patterns = [
      pattern('P1', 'ROUTE-CARDINALITY', 0, [meters(100, 0), meters(100, 0)]),
      pattern('P2', 'ROUTE-CARDINALITY', 0, [meters(0, 0), meters(0, 0)]),
    ]
    const shapes = [
      tinyShapeAt('S1', 'ROUTE-CARDINALITY', 0, 0),
      tinyShapeAt('S2', 'ROUTE-CARDINALITY', 300, 0),
    ]

    expect(matchedShapeByPattern(patterns, shapes)).toEqual({ P1: 'S2', P2: 'S1' })
  })

  it('uses total-assignment tolerance without lexical tie-breaking', () => {
    const routePattern = pattern('TOLERANCE', 'ROUTE-TOLERANCE', 0, [meters(0, 0), meters(0, 0)])
    const result = matchShapesToPatterns([routePattern], [
      tinyShapeAt('BEST', 'ROUTE-TOLERANCE', 0, 0),
      tinyShapeAt('WITHIN-ONE-METER', 'ROUTE-TOLERANCE', 0, 0.5),
    ])

    expect(result.matches).toEqual([])
    expect(result.unresolved).toEqual([{
      patternId: 'TOLERANCE',
      reason: 'tolerance-equivalent-alternatives',
      candidateShapeIds: ['BEST', 'WITHIN-ONE-METER'],
    }])
  })

  it('returns the same result for every pattern and Shape permutation', () => {
    const expected = matchShapesToPatterns(reviewMatrixPatterns, reviewMatrixShapes)
    for (const patterns of permutations(reviewMatrixPatterns)) {
      for (const shapes of permutations(reviewMatrixShapes)) {
        expect(matchShapesToPatterns(patterns, shapes)).toEqual(expected)
      }
    }
  })
})

describe('diagnostics, identity, and input invariants', () => {
  it('keeps original compatible candidates when a Shape is assigned to another pattern', () => {
    const patterns = [
      pattern('WINNER', 'ROUTE-OVER', 0, [meters(0, 0), meters(0, 0)]),
      pattern('LOSER', 'ROUTE-OVER', 0, [meters(100, 0), meters(100, 0)]),
    ]
    const onlyShape = tinyShapeAt('ONLY', 'ROUTE-OVER', 0, 0)
    const result = matchShapesToPatterns(patterns, [onlyShape])

    expect(result.matches).toEqual([expect.objectContaining({ patternId: 'WINNER', shapeId: 'ONLY' })])
    expect(result.unresolved).toEqual([{
      patternId: 'LOSER',
      reason: 'compatible-shape-assigned',
      candidateShapeIds: ['ONLY'],
    }])
  })

  it('handles an undersubscribed partition and reports the unused Shape', () => {
    const routePattern = pattern('ONLY-PATTERN', 'ROUTE-UNDER', 0, [meters(0, 0), meters(0, 0)])
    const result = matchShapesToPatterns([routePattern], [
      tinyShapeAt('NEAR', 'ROUTE-UNDER', 0, 0),
      tinyShapeAt('FAR', 'ROUTE-UNDER', 100, 0),
    ])

    expect(result.matches).toEqual([expect.objectContaining({ shapeId: 'NEAR' })])
    expect(result.unusedShapeIds).toEqual(['FAR'])
  })

  it('uses geometry when duplicate SubRouteUIDs make complete identity non-unique', () => {
    const patterns = [
      pattern('DUP-A', 'ROUTE-DUP-ID', 0, [meters(0, 0), meters(100, 0)], 'DUP'),
      pattern('DUP-B', 'ROUTE-DUP-ID', 0, [meters(0, 100), meters(100, 100)], 'DUP'),
    ]
    const shapes = [
      shape('DUP-SHAPE-A', 'ROUTE-DUP-ID', 0, [meters(0, 0), meters(100, 0)], 'DUP'),
      shape('DUP-SHAPE-B', 'ROUTE-DUP-ID', 0, [meters(0, 100), meters(100, 100)], 'DUP'),
    ]
    const result = matchShapesToPatterns(patterns, shapes)

    expect(result.matches.map(({ patternId, shapeId, basis }) => ({ patternId, shapeId, basis }))).toEqual([
      { patternId: 'DUP-A', shapeId: 'DUP-SHAPE-A', basis: 'geometry' },
      { patternId: 'DUP-B', shapeId: 'DUP-SHAPE-B', basis: 'geometry' },
    ])
  })

  it('matches unique exact identities before and independently of geometry assignment', () => {
    const crossedShapes = [
      { ...siblingShapesWithIdentity[0], coordinates: siblingShapesWithIdentity[1].coordinates },
      { ...siblingShapesWithIdentity[1], coordinates: siblingShapesWithIdentity[0].coordinates },
    ]
    const result = matchShapesToPatterns(siblingPatterns, crossedShapes)

    expect(result.matches).toEqual([
      { patternId: 'SUB-A:0', shapeId: 'SHAPE-A', basis: 'exact-identity', costMeters: null, metrics: null },
      { patternId: 'SUB-B:0', shapeId: 'SHAPE-B', basis: 'exact-identity', costMeters: null, metrics: null },
    ])
  })

  it('does not use geometry to unlock contradictory complete identities', () => {
    const result = matchShapesToPatterns(
      [siblingPatterns[0]],
      [{ ...siblingShapesWithIdentity[0], shapeId: 'CONTRADICTORY', subRouteUid: 'SUB-B' }],
    )

    expect(result.matches).toEqual([])
    expect(result.unresolved).toEqual([{
      patternId: 'SUB-A:0',
      reason: 'contradictory-complete-identity',
      candidateShapeIds: [],
    }])
  })

  it('marks a pattern with no stops invalid', () => {
    const empty = { ...siblingPatterns[0], patternId: 'EMPTY', stops: [] }
    expect(matchShapesToPatterns([empty], siblingShapesWithoutIdentity).unresolved).toEqual([{
      patternId: 'EMPTY', reason: 'invalid-pattern', candidateShapeIds: [],
    }])
  })

  it('normalizes consecutive duplicates on a copy and distinguishes unusable Shapes', () => {
    const routePattern = pattern('DUPLICATE-POINTS', 'ROUTE-DUP', 0, [meters(0, 0), meters(200, 0)])
    const result = matchShapesToPatterns(
      [routePattern],
      [shapeWithConsecutiveDuplicates, allDuplicateShape, invalidCoordinateShape],
    )

    expect(result.matches).toEqual([expect.objectContaining({ shapeId: 'CONSECUTIVE-DUPLICATES' })])
    expect(result.rejectedShapes).toEqual([
      { shapeId: 'ALL-DUPLICATE', reason: 'invalid-coordinates' },
      { shapeId: 'INVALID-COORDINATE', reason: 'invalid-coordinates' },
    ])
  })

  it('reports rejected or invalid Shapes when no valid candidate remains', () => {
    const routePattern = pattern('ONLY-INVALID', 'ROUTE-DUP', 0, [meters(0, 0), meters(100, 0)])
    const result = matchShapesToPatterns([routePattern], [allDuplicateShape])

    expect(result.unresolved).toEqual([{
      patternId: 'ONLY-INVALID', reason: 'rejected-or-invalid-shapes', candidateShapeIds: [],
    }])
  })

  it('does not let a duplicate Shape ID contaminate another legal Shape', () => {
    const routePattern = pattern('LEGAL', 'ROUTE-DUP-SHAPE', 0, [meters(0, 0), meters(100, 0)])
    const duplicateOne = shape('DUPLICATE-ID', 'ROUTE-DUP-SHAPE', 0, [meters(0, 0), meters(100, 0)])
    const duplicateTwo = shape('DUPLICATE-ID', 'ROUTE-DUP-SHAPE', 0, [meters(0, 10), meters(100, 10)])
    const legal = shape('LEGAL-SHAPE', 'ROUTE-DUP-SHAPE', 0, [meters(0, 0), meters(100, 0)])
    const result = matchShapesToPatterns([routePattern], [duplicateOne, legal, duplicateTwo])

    expect(result.matches).toEqual([expect.objectContaining({ shapeId: 'LEGAL-SHAPE' })])
    expect(result.rejectedShapes).toEqual([{ shapeId: 'DUPLICATE-ID', reason: 'duplicate-shape-id' }])
  })

  it('keeps permutation results stable when rejected candidates are mixed in', () => {
    const rejected = shape('REJECTED', 'ROUTE-ASSIGN', 0, [coordinate(Number.NaN, 25), coordinate(121, 25)])
    const shapes = [...reviewMatrixShapes, rejected]
    const expected = matchShapesToPatterns(reviewMatrixPatterns, shapes)
    for (const patterns of permutations(reviewMatrixPatterns)) {
      for (const candidates of permutations(shapes)) {
        expect(matchShapesToPatterns(patterns, candidates)).toEqual(expected)
      }
    }
  })

  it('returns a deep-equal complete result across repeated runs', () => {
    const expected = matchShapesToPatterns(reviewMatrixPatterns, reviewMatrixShapes)
    for (let run = 0; run < 10; run += 1) {
      expect(matchShapesToPatterns(reviewMatrixPatterns, reviewMatrixShapes)).toEqual(expected)
    }
  })

  it('does not modify deeply frozen inputs', () => {
    const patterns = structuredClone(siblingPatterns)
    const shapes = structuredClone(siblingShapesWithoutIdentity)
    const beforePatterns = structuredClone(patterns)
    const beforeShapes = structuredClone(shapes)
    for (const item of patterns) {
      Object.freeze(item.stops)
      for (const patternStop of item.stops) {
        Object.freeze(patternStop.coordinate)
        Object.freeze(patternStop)
      }
      Object.freeze(item)
    }
    for (const item of shapes) {
      Object.freeze(item.coordinates)
      for (const point of item.coordinates) Object.freeze(point)
      Object.freeze(item)
    }
    Object.freeze(patterns)
    Object.freeze(shapes)

    expect(() => matchShapesToPatterns(patterns, shapes)).not.toThrow()
    expect(patterns).toEqual(beforePatterns)
    expect(shapes).toEqual(beforeShapes)
  })
})
