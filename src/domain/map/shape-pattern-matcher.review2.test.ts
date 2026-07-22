import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import {
  matchShapesToPatterns,
  type RouteShapeCandidate,
  type ShapePatternCandidate,
  type ShapePatternCoordinate,
} from './shape-pattern-matcher'

const BASE_LONGITUDE = 121
const BASE_LATITUDE = 25
const LONGITUDE_METERS = 111_320 * Math.cos(BASE_LATITUDE * Math.PI / 180)
const LATITUDE_METERS = 110_574
const EPSILON = 1e-8

function meters(x: number, y: number): ShapePatternCoordinate {
  return [BASE_LONGITUDE + x / LONGITUDE_METERS, BASE_LATITUDE + y / LATITUDE_METERS]
}

function pattern(
  patternId: string,
  routeUid: string,
  direction: 0 | 1 | 2,
  points: readonly ShapePatternCoordinate[],
  subRouteUid: string | null = null,
): ShapePatternCandidate {
  return {
    patternId,
    routeUid,
    subRouteUid,
    direction,
    stops: points.map((coordinate, index) => ({ stopUid: `${patternId}-${index + 1}`, coordinate })),
  }
}

function shape(
  shapeId: string,
  routeUid: string,
  direction: 0 | 1 | 2,
  coordinates: readonly ShapePatternCoordinate[],
  subRouteUid: string | null = null,
): RouteShapeCandidate {
  return { shapeId, routeUid, subRouteUid, direction, coordinates }
}

function tinyShapeAt(
  shapeId: string,
  routeUid: string,
  x: number,
  y: number,
): RouteShapeCandidate {
  return shape(shapeId, routeUid, 0, [meters(x - 0.01, y), meters(x + 0.01, y)])
}

function approximateDistanceMeters(a: ShapePatternCoordinate, b: ShapePatternCoordinate): number {
  const latitude = (a[1] + b[1]) * Math.PI / 360
  return Math.hypot(
    (a[0] - b[0]) * Math.cos(latitude) * 111_320,
    (a[1] - b[1]) * 110_574,
  )
}

type OracleProjection = {
  segmentIndex: number
  segmentFraction: number
  progressMeters: number
  distanceMeters: number
}

type OraclePath = {
  projections: OracleProjection[]
  distanceSumMeters: number
  meanStopDistanceMeters: number
  maxStopDistanceMeters: number
  costMeters: number
  spanMeters: number
  key: string
}

type OracleOrientation = {
  costMeters: number
  meanStopDistanceMeters: number
  maxStopDistanceMeters: number
  endpointDistanceMeters: number | null
  matchedSpanMeters: number
  shapeLengthMeters: number
}

/**
 * Test-only exhaustive oracle. It enumerates every legal monotonic projection
 * combination; production code is never called to derive the expected result.
 */
function exhaustivePairOracle(
  patternCandidate: ShapePatternCandidate,
  shapeCandidate: RouteShapeCandidate,
): OracleOrientation {
  const orientations = [
    shapeCandidate.coordinates.map(copyCoordinate),
    [...shapeCandidate.coordinates].reverse().map(copyCoordinate),
  ]
  const scores: OracleOrientation[] = []

  for (let coordinates of orientations) {
    let maxSpanMeters: number | null = null
    if (patternCandidate.direction === 2) {
      if (coordinates.length < 4) continue
      if (approximateDistanceMeters(coordinates[0], coordinates.at(-1)!) > 500) continue
      if (!coordinatesEqual(coordinates[0], coordinates.at(-1)!)) {
        coordinates = [...coordinates, copyCoordinate(coordinates[0])]
      }
      maxSpanMeters = polylineLengthMeters(coordinates)
      coordinates = [...coordinates, ...coordinates.slice(1).map(copyCoordinate)]
    }

    const segments = buildOracleSegments(coordinates)
    if (!segments.length) continue
    const projections = patternCandidate.stops.map((stop) =>
      segments.map((segment) => projectOracle(stop.coordinate, segment)))
    const legalPaths: OraclePath[] = []
    const selected = new Array<OracleProjection>(patternCandidate.stops.length)

    const visit = (stopIndex: number): void => {
      if (stopIndex === selected.length) {
        const spanMeters = selected.at(-1)!.progressMeters - selected[0].progressMeters
        if (maxSpanMeters !== null && spanMeters > maxSpanMeters + EPSILON) return
        const distanceSumMeters = selected.reduce((total, projection) => total + projection.distanceMeters, 0)
        const meanStopDistanceMeters = distanceSumMeters / selected.length
        const maxStopDistanceMeters = Math.max(...selected.map((projection) => projection.distanceMeters))
        if (meanStopDistanceMeters > 250 || maxStopDistanceMeters > 1_000) return
        legalPaths.push({
          projections: selected.map((projection) => ({ ...projection })),
          distanceSumMeters,
          meanStopDistanceMeters,
          maxStopDistanceMeters,
          costMeters: meanStopDistanceMeters + maxStopDistanceMeters * 0.25,
          spanMeters,
          key: selected.map((projection) =>
            `${projection.segmentIndex}:${projection.segmentFraction.toFixed(12)}`).join('|'),
        })
        return
      }

      for (const projection of projections[stopIndex]) {
        if (stopIndex > 0) {
          const previous = selected[stopIndex - 1]
          if (previous.segmentIndex > projection.segmentIndex) continue
          if (
            previous.segmentIndex === projection.segmentIndex
            && previous.segmentFraction > projection.segmentFraction + EPSILON
          ) continue
        }
        selected[stopIndex] = projection
        visit(stopIndex + 1)
      }
    }

    visit(0)
    if (!legalPaths.length) continue
    const costPath = [...legalPaths].sort(compareOracleCostPath)[0]
    const diagnosticPath = patternCandidate.direction === 2
      ? [...legalPaths].sort(compareOracleSpanPath)[0]
      : costPath
    const baseCoordinates = patternCandidate.direction === 2
      ? coordinates.slice(0, Math.floor(coordinates.length / 2) + 1)
      : coordinates
    const shapeLengthMeters = polylineLengthMeters(baseCoordinates)
    const endpointDistanceMeters = patternCandidate.direction === 2
      ? null
      : average([
          approximateDistanceMeters(patternCandidate.stops[0].coordinate, coordinates[0]),
          approximateDistanceMeters(patternCandidate.stops.at(-1)!.coordinate, coordinates.at(-1)!),
        ])
    if (endpointDistanceMeters !== null && endpointDistanceMeters > 1_500) continue
    scores.push({
      costMeters: costPath.costMeters,
      meanStopDistanceMeters: costPath.meanStopDistanceMeters,
      maxStopDistanceMeters: costPath.maxStopDistanceMeters,
      endpointDistanceMeters,
      matchedSpanMeters: diagnosticPath.spanMeters,
      shapeLengthMeters,
    })
  }

  assert(scores.length > 0, 'oracle expected at least one legal orientation')
  return scores.sort(compareOracleOrientation)[0]
}

function buildOracleSegments(coordinates: readonly ShapePatternCoordinate[]) {
  const segments: Array<{
    segmentIndex: number
    start: ShapePatternCoordinate
    end: ShapePatternCoordinate
    lengthMeters: number
    startProgressMeters: number
  }> = []
  let progressMeters = 0
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const lengthMeters = approximateDistanceMeters(coordinates[index], coordinates[index + 1])
    if (!(lengthMeters > 0)) continue
    segments.push({
      segmentIndex: index,
      start: coordinates[index],
      end: coordinates[index + 1],
      lengthMeters,
      startProgressMeters: progressMeters,
    })
    progressMeters += lengthMeters
  }
  return segments
}

function projectOracle(
  stop: ShapePatternCoordinate,
  segment: ReturnType<typeof buildOracleSegments>[number],
): OracleProjection {
  const referenceLatitudeRadians = ((segment.start[1] + segment.end[1] + stop[1]) / 3) * Math.PI / 180
  const longitudeScale = Math.cos(referenceLatitudeRadians) * 111_320
  const latitudeScale = 110_574
  const segmentX = (segment.end[0] - segment.start[0]) * longitudeScale
  const segmentY = (segment.end[1] - segment.start[1]) * latitudeScale
  const stopX = (stop[0] - segment.start[0]) * longitudeScale
  const stopY = (stop[1] - segment.start[1]) * latitudeScale
  const squaredLength = segmentX * segmentX + segmentY * segmentY
  const segmentFraction = squaredLength > 0
    ? Math.max(0, Math.min(1, (stopX * segmentX + stopY * segmentY) / squaredLength))
    : 0
  const point: ShapePatternCoordinate = [
    segment.start[0] + (segment.end[0] - segment.start[0]) * segmentFraction,
    segment.start[1] + (segment.end[1] - segment.start[1]) * segmentFraction,
  ]
  return {
    segmentIndex: segment.segmentIndex,
    segmentFraction,
    progressMeters: segment.startProgressMeters + segment.lengthMeters * segmentFraction,
    distanceMeters: approximateDistanceMeters(stop, point),
  }
}

function compareOracleCostPath(a: OraclePath, b: OraclePath): number {
  return compareNumber(a.costMeters, b.costMeters)
    || compareNumber(b.spanMeters, a.spanMeters)
    || compareNumber(a.meanStopDistanceMeters, b.meanStopDistanceMeters)
    || compareNumber(a.maxStopDistanceMeters, b.maxStopDistanceMeters)
    || a.key.localeCompare(b.key)
}

function compareOracleSpanPath(a: OraclePath, b: OraclePath): number {
  return compareNumber(b.spanMeters, a.spanMeters)
    || compareNumber(a.costMeters, b.costMeters)
    || compareNumber(a.meanStopDistanceMeters, b.meanStopDistanceMeters)
    || compareNumber(a.maxStopDistanceMeters, b.maxStopDistanceMeters)
    || a.key.localeCompare(b.key)
}

function compareOracleOrientation(a: OracleOrientation, b: OracleOrientation): number {
  return compareNumber(a.costMeters, b.costMeters)
    || compareNumber(a.endpointDistanceMeters ?? Number.POSITIVE_INFINITY,
      b.endpointDistanceMeters ?? Number.POSITIVE_INFINITY)
    || compareNumber(b.matchedSpanMeters, a.matchedSpanMeters)
    || compareNumber(a.meanStopDistanceMeters, b.meanStopDistanceMeters)
    || compareNumber(a.maxStopDistanceMeters, b.maxStopDistanceMeters)
}

function compareNumber(a: number, b: number): number {
  if (Math.abs(a - b) <= EPSILON) return 0
  return a < b ? -1 : 1
}

function polylineLengthMeters(coordinates: readonly ShapePatternCoordinate[]): number {
  let total = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    total += approximateDistanceMeters(coordinates[index - 1], coordinates[index])
  }
  return total
}

function average(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function coordinatesEqual(a: ShapePatternCoordinate, b: ShapePatternCoordinate): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function copyCoordinate(coordinate: ShapePatternCoordinate): ShapePatternCoordinate {
  return [coordinate[0], coordinate[1]]
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

function targetOutcome(result: ReturnType<typeof matchShapesToPatterns>): string {
  if (result.matches.some((match) => match.patternId === 'TARGET')) return 'mandatory'
  return result.unresolved.find((entry) => entry.patternId === 'TARGET')?.reason ?? 'missing'
}

function toleranceFixture(
  fixedSiblingCount: number,
  bestCostMeters: number,
  deltaMeters: number,
  options: { extraShapes?: number; extraPatterns?: number } = {},
) {
  const routeUid = `ROUTE-TOL-${fixedSiblingCount}-${bestCostMeters}-${deltaMeters}-${options.extraShapes ?? 0}-${options.extraPatterns ?? 0}`
  const patterns: ShapePatternCandidate[] = [
    pattern('TARGET', routeUid, 0, [meters(0, 0), meters(0, 0)]),
  ]
  const shapes: RouteShapeCandidate[] = [
    tinyShapeAt('BEST', routeUid, 0, bestCostMeters / 1.25),
    tinyShapeAt('ALTERNATIVE', routeUid, 0, (bestCostMeters + deltaMeters) / 1.25),
  ]
  for (let index = 0; index < fixedSiblingCount; index += 1) {
    const x = 3_000 * (index + 1)
    patterns.push(pattern(`FIXED-${index}`, routeUid, 0, [meters(x, 0), meters(x, 0)]))
    shapes.push(tinyShapeAt(`FIXED-SHAPE-${index}`, routeUid, x + 160, 0))
  }
  for (let index = 0; index < (options.extraShapes ?? 0); index += 1) {
    shapes.push(tinyShapeAt(`UNUSED-${index}`, routeUid, 50_000 + index * 2_000, 0))
  }
  for (let index = 0; index < (options.extraPatterns ?? 0); index += 1) {
    const x = 80_000 + index * 2_000
    patterns.push(pattern(`UNMATCHED-${index}`, routeUid, 0, [meters(x, 0), meters(x, 0)]))
  }
  return matchShapesToPatterns(patterns, shapes)
}

describe('second-round projection objective', () => {
  it('optimizes the metric actually used as pair cost', () => {
    const routePattern = pattern('OBJECTIVE', 'ROUTE-OBJECTIVE', 2, [
      meters(75, -50),
      meters(75, 150),
      meters(100, 0),
    ])
    const routeShape = shape('SQUARE', 'ROUTE-OBJECTIVE', 2, [
      meters(0, 0),
      meters(100, 0),
      meters(100, 100),
      meters(0, 100),
      meters(0, 0),
    ])

    const oracle = exhaustivePairOracle(routePattern, routeShape)
    const match = matchShapesToPatterns([routePattern], [routeShape]).matches[0]!

    assert(match.costMeters! < 60)
    assert(Math.abs(match.costMeters! - oracle.costMeters) < 0.02)
    assert(Math.abs(match.metrics!.matchedSpanMeters - 400) < 0.2)
    assert(Math.abs(match.metrics!.matchedSpanMeters - oracle.matchedSpanMeters) < 0.2)
  })

  it('agrees with an exhaustive oracle for Direction 0, 1, and 2', () => {
    const cases: Array<[ShapePatternCandidate, RouteShapeCandidate]> = [
      [
        pattern('ORACLE-0', 'ROUTE-ORACLE-0', 0, [meters(20, 25), meters(80, -10), meters(120, 30)]),
        shape('SHAPE-0', 'ROUTE-ORACLE-0', 0, [meters(0, 0), meters(100, 0), meters(100, 50), meters(150, 50)]),
      ],
      [
        pattern('ORACLE-1', 'ROUTE-ORACLE-1', 1, [meters(120, 30), meters(80, -10), meters(20, 25)]),
        shape('SHAPE-1', 'ROUTE-ORACLE-1', 1, [meters(0, 0), meters(100, 0), meters(100, 50), meters(150, 50)]),
      ],
      [
        pattern('ORACLE-2', 'ROUTE-ORACLE-2', 2, [meters(90, 20), meters(20, 90), meters(0, 0)]),
        shape('SHAPE-2', 'ROUTE-ORACLE-2', 2, [meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0)]),
      ],
    ]

    for (const [routePattern, routeShape] of cases) {
      const oracle = exhaustivePairOracle(routePattern, routeShape)
      const match = matchShapesToPatterns([routePattern], [routeShape]).matches[0]!
      assert(Math.abs(match.costMeters! - oracle.costMeters) < 0.02, routePattern.patternId)
      assert(Math.abs(match.metrics!.matchedSpanMeters - oracle.matchedSpanMeters) < 0.2,
        `${routePattern.patternId} span`)
    }
  })

  it('is deterministic across candidate permutations and repeated reconstruction', () => {
    const routePattern = pattern('RECONSTRUCT', 'ROUTE-RECONSTRUCT', 0, [
      meters(80, 0), meters(20, 0), meters(-80, 0),
    ])
    const correct = shape('CORRECT', 'ROUTE-RECONSTRUCT', 0, [
      meters(0, 0), meters(100, 0), meters(0, 0), meters(-100, 0),
    ])
    const offset = shape('OFFSET', 'ROUTE-RECONSTRUCT', 0, [
      meters(0, 20), meters(100, 20), meters(0, 20), meters(-100, 20),
    ])
    const expected = matchShapesToPatterns([routePattern], [correct, offset])
    for (let run = 0; run < 10; run += 1) {
      assert.deepEqual(matchShapesToPatterns([routePattern], run % 2 ? [offset, correct] : [correct, offset]), expected)
    }
    assert(Math.abs(expected.matches[0].metrics!.matchedSpanMeters - 200) < 0.2)
  })
})

describe('Direction 2 diagnostic-only coverage policy', () => {
  it('does not choose a truncated Shape over a legal terminal loop', () => {
    const routePattern = pattern('TERMINAL', 'ROUTE-TERMINAL', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
    ])
    const correct = shape('CORRECT', 'ROUTE-TERMINAL', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
      meters(-50, 100), meters(-50, 0), meters(0, 0),
    ])
    const truncated = shape('TRUNCATED', 'ROUTE-TERMINAL', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ])

    const result = matchShapesToPatterns([routePattern], [truncated, correct])

    assert(!result.matches.some((match) => match.shapeId === 'TRUNCATED'))
    assert.deepEqual(result.unresolved, [{
      patternId: 'TERMINAL',
      reason: 'tolerance-equivalent-alternatives',
      candidateShapeIds: ['CORRECT', 'TRUNCATED'],
    }])
  })

  it('fails closed when the difference is a small legal connector', () => {
    const routePattern = pattern('CONNECTOR', 'ROUTE-CONNECTOR', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
    ])
    const withConnector = shape('WITH-CONNECTOR', 'ROUTE-CONNECTOR', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
      meters(-20, 80), meters(0, 0),
    ])
    const withoutConnector = shape('WITHOUT-CONNECTOR', 'ROUTE-CONNECTOR', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ])

    const result = matchShapesToPatterns([routePattern], [withoutConnector, withConnector])

    assert.equal(result.matches.length, 0)
    assert.deepEqual(result.unresolved[0].candidateShapeIds, ['WITH-CONNECTOR', 'WITHOUT-CONNECTOR'])
  })

  it('fails closed for two plausible partly collinear sibling loops', () => {
    const routePattern = pattern('PLAUSIBLE', 'ROUTE-PLAUSIBLE', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
    ])
    const loopA = shape('LOOP-A', 'ROUTE-PLAUSIBLE', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ])
    const loopB = shape('LOOP-B', 'ROUTE-PLAUSIBLE', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(-10, 50), meters(0, 0),
    ])

    const result = matchShapesToPatterns([routePattern], [loopB, loopA])

    assert.equal(result.matches.length, 0)
    assert.deepEqual(result.unresolved[0].candidateShapeIds, ['LOOP-A', 'LOOP-B'])
  })

  it('keeps start rotation, reverse encoding, and coordinate density diagnostic-only', () => {
    const routePattern = pattern('VARIANTS', 'ROUTE-VARIANTS', 2, [
      meters(5, 5), meters(95, 5), meters(95, 95), meters(5, 95),
    ])
    const baseCoordinates = [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ]
    const variants = [
      shape('BASE', 'ROUTE-VARIANTS', 2, baseCoordinates),
      shape('ROTATED', 'ROUTE-VARIANTS', 2, rotateClosedLoop(baseCoordinates, 2)),
      shape('REVERSED', 'ROUTE-VARIANTS', 2, [...baseCoordinates].reverse()),
      shape('DENSE', 'ROUTE-VARIANTS', 2, densifyClosedLoop(baseCoordinates)),
    ]
    const matches = variants.map((candidate) =>
      matchShapesToPatterns([routePattern], [candidate]).matches[0]!)

    for (const match of matches.slice(1)) {
      assert(Math.abs(match.costMeters! - matches[0].costMeters!) < 0.02)
      assert(Math.abs(match.metrics!.shapeLengthMeters - matches[0].metrics!.shapeLengthMeters) < 0.2)
      assert(Math.abs(match.metrics!.matchedSpanMeters - matches[0].metrics!.matchedSpanMeters) < 0.2)
    }
  })

  it('handles a seam exactly at a stop projection', () => {
    const routePattern = pattern('SEAM', 'ROUTE-SEAM-EXACT', 2, [
      meters(0, 100), meters(0, 0), meters(100, 0),
    ])
    const loop = shape('LOOP', 'ROUTE-SEAM-EXACT', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100), meters(0, 0),
    ])
    const match = matchShapesToPatterns([routePattern], [loop]).matches[0]!

    assert.equal(match.costMeters, 0)
    assert(match.metrics!.matchedSpanMeters <= match.metrics!.shapeLengthMeters + 0.01)
  })

  it('does not let an exact-prefix long detour win', () => {
    const routePattern = pattern('DETOUR', 'ROUTE-DETOUR', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
    ])
    const normal = shape('NORMAL', 'ROUTE-DETOUR', 2, [
      meters(1, 1), meters(101, 1), meters(101, 101), meters(1, 101), meters(1, 1),
    ])
    const detour = shape('DETOUR-LONG', 'ROUTE-DETOUR', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
      meters(1_000, 1_000), meters(0, 0),
    ])

    const result = matchShapesToPatterns([routePattern], [detour, normal])

    assert(!result.matches.some((match) => match.shapeId === 'DETOUR-LONG'))
    assert.deepEqual(result.unresolved[0].candidateShapeIds, ['DETOUR-LONG', 'NORMAL'])
  })

  it('still matches the only legal Direction 2 Shape and exposes diagnostics only', () => {
    const routePattern = pattern('ONLY', 'ROUTE-ONLY-LOOP', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
    ])
    const onlyShape = shape('ONLY-SHAPE', 'ROUTE-ONLY-LOOP', 2, [
      meters(0, 0), meters(100, 0), meters(100, 100), meters(0, 100),
      meters(-30, 100), meters(0, 0),
    ])
    const match = matchShapesToPatterns([routePattern], [onlyShape]).matches[0]!

    assert.equal(match.shapeId, 'ONLY-SHAPE')
    assert.equal(match.costMeters, 0)
    assert(match.metrics!.coverageDeficitMeters !== null)
  })
})

describe('full original compatibility diagnostics', () => {
  it('retains a geometry-compatible Shape consumed by exact identity', () => {
    const exact = pattern(
      'EXACT',
      'ROUTE-DIAG',
      0,
      [meters(0, 0), meters(100, 0)],
      'SUB-A',
    )
    const fallback = pattern(
      'FALLBACK',
      'ROUTE-DIAG',
      0,
      [meters(0, 0), meters(100, 0)],
    )
    const onlyShape = shape(
      'ONLY',
      'ROUTE-DIAG',
      0,
      [meters(0, 0), meters(100, 0)],
      'SUB-A',
    )

    const result = matchShapesToPatterns([exact, fallback], [onlyShape])

    assert.deepEqual(result.unresolved, [{
      patternId: 'FALLBACK',
      reason: 'compatible-shape-assigned',
      candidateShapeIds: ['ONLY'],
    }])
  })
})

describe('common-cost-invariant assignment tolerance', () => {
  it('is invariant to 0, 1, 4, or 8 unrelated fixed siblings', () => {
    for (const siblingCount of [0, 1, 4, 8]) {
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 0, 0.999)),
        'tolerance-equivalent-alternatives')
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 0, 1)),
        'tolerance-equivalent-alternatives')
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 0, 1.001)), 'mandatory')
    }
  })

  it('uses the changed sub-assignment at relative just-below, exact, and just-above boundaries', () => {
    for (const siblingCount of [0, 1, 4, 8]) {
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 240, 1.199)),
        'tolerance-equivalent-alternatives')
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 240, 1.2)),
        'tolerance-equivalent-alternatives')
      assert.equal(targetOutcome(toleranceFixture(siblingCount, 240, 1.201)), 'mandatory')
    }
  })

  it('keeps the same decision in rectangular and oversubscribed partitions', () => {
    const baseline = targetOutcome(toleranceFixture(4, 0, 1.001))
    assert.equal(baseline, 'mandatory')
    assert.equal(targetOutcome(toleranceFixture(4, 0, 1.001, { extraShapes: 3 })), baseline)
    assert.equal(targetOutcome(toleranceFixture(4, 0, 1.001, { extraPatterns: 3 })), baseline)
  })

  it('handles an unmatched outcome as a changed sub-assignment', () => {
    for (const siblingCount of [0, 4, 8]) {
      const routeUid = `ROUTE-UNMATCHED-${siblingCount}`
      const patterns: ShapePatternCandidate[] = [
        pattern('TARGET', routeUid, 0, [meters(0, 0), meters(0, 0)]),
        pattern('COMPETITOR', routeUid, 0, [meters(0, 0.64), meters(0, 0.64)]),
      ]
      const shapes: RouteShapeCandidate[] = [tinyShapeAt('ONLY', routeUid, 0, 0)]
      for (let index = 0; index < siblingCount; index += 1) {
        const x = 3_000 * (index + 1)
        patterns.push(pattern(`FIXED-${index}`, routeUid, 0, [meters(x, 0), meters(x, 0)]))
        shapes.push(tinyShapeAt(`FIXED-SHAPE-${index}`, routeUid, x + 160, 0))
      }
      assert.equal(targetOutcome(matchShapesToPatterns(patterns, shapes)),
        'tolerance-equivalent-alternatives')
    }
  })

  it('keeps exact assignment ties unresolved while accepting a shared fixed edge', () => {
    const routeUid = 'ROUTE-SHARED-REVIEW-2'
    const patterns = [
      pattern('A', routeUid, 0, [meters(0, 0), meters(0, 0)]),
      pattern('B', routeUid, 0, [meters(0, 0), meters(0, 0)]),
      pattern('FIXED', routeUid, 0, [meters(3_000, 0), meters(3_000, 0)]),
    ]
    const shapes = [
      tinyShapeAt('X', routeUid, 0, 0),
      tinyShapeAt('Y', routeUid, 0, 0),
      tinyShapeAt('FIXED-SHAPE', routeUid, 3_160, 0),
    ]
    const result = matchShapesToPatterns(patterns, shapes)

    assert(result.matches.some((match) => match.patternId === 'FIXED' && match.shapeId === 'FIXED-SHAPE'))
    assert.deepEqual(result.unresolved.map(({ patternId, reason }) => ({ patternId, reason })), [
      { patternId: 'A', reason: 'assignment-ambiguous' },
      { patternId: 'B', reason: 'assignment-ambiguous' },
    ])
  })
})
