import { assert, describe, it } from 'vitest'
import {
  matchShapesToPatterns,
  type RouteShapeCandidate,
  type ShapePatternCandidate,
  type ShapePatternCoordinate,
  type ShapePatternGeometryMetrics,
  type ShapePatternMatcherOptions,
} from './shape-pattern-matcher'

const BASE_LONGITUDE = 121
const BASE_LATITUDE = 25
const LONGITUDE_METERS = 111_320 * Math.cos(BASE_LATITUDE * Math.PI / 180)
const LATITUDE_METERS = 110_574
const ORACLE_FLOATING_EPSILON_FACTOR = 64
const ORACLE_NUMERIC_METERS_EPSILON = 1e-9

type CoordinateFactory = (x: number, y: number) => ShapePatternCoordinate

type OracleSegment = {
  segmentIndex: number
  start: ShapePatternCoordinate
  end: ShapePatternCoordinate
  lengthMeters: number
  startProgressMeters: number
}

type OracleProjection = {
  segmentIndex: number
  segmentFraction: number
  progressMeters: number
  distanceMeters: number
}

function meters(x: number, y: number): ShapePatternCoordinate {
  return [BASE_LONGITUDE + x / LONGITUDE_METERS, BASE_LATITUDE + y / LATITUDE_METERS]
}

function equatorMeters(x: number, y: number): ShapePatternCoordinate {
  return [x / 111_320, y / LATITUDE_METERS]
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
    direction,
    subRouteUid,
    stops: points.map((coordinate, index) => ({
      stopUid: `${patternId}-${index + 1}`,
      coordinate,
    })),
  }
}

function shape(
  shapeId: string,
  routeUid: string,
  direction: 0 | 1 | 2,
  coordinates: readonly ShapePatternCoordinate[],
  subRouteUid: string | null = null,
): RouteShapeCandidate {
  return { shapeId, routeUid, direction, subRouteUid, coordinates }
}

function nearClosedCoordinates(
  gapMeters: number,
  coordinate: CoordinateFactory = meters,
): ShapePatternCoordinate[] {
  return [
    coordinate(0, 0),
    coordinate(0, 1_000),
    coordinate(gapMeters, 1_000),
    coordinate(gapMeters, 0),
  ]
}

function trulyClosedCoordinates(
  widthMeters = 400,
  coordinate: CoordinateFactory = meters,
): ShapePatternCoordinate[] {
  const open = nearClosedCoordinates(widthMeters, coordinate)
  return [...open, open[0]]
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

function approximateDistanceMeters(a: ShapePatternCoordinate, b: ShapePatternCoordinate): number {
  const latitude = (a[1] + b[1]) * Math.PI / 360
  return Math.hypot(
    (a[0] - b[0]) * Math.cos(latitude) * 111_320,
    (a[1] - b[1]) * LATITUDE_METERS,
  )
}

function oracleFloatingEpsilon(limit: number): number {
  return Math.max(
    ORACLE_NUMERIC_METERS_EPSILON,
    Number.EPSILON * ORACLE_FLOATING_EPSILON_FACTOR * Math.max(1, Math.abs(limit)),
  )
}

/** Independent test policy: intentionally does not call any production comparison helper. */
function oracleAtOrBelowThreshold(value: number, limit: number): boolean {
  return value <= limit + oracleFloatingEpsilon(limit)
}

function buildActualOracleSegments(
  coordinates: readonly ShapePatternCoordinate[],
): OracleSegment[] {
  const segments: OracleSegment[] = []
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
  segment: OracleSegment,
): OracleProjection {
  const referenceLatitudeRadians = ((segment.start[1] + segment.end[1] + stop[1]) / 3)
    * Math.PI / 180
  const longitudeScale = Math.cos(referenceLatitudeRadians) * 111_320
  const segmentX = (segment.end[0] - segment.start[0]) * longitudeScale
  const segmentY = (segment.end[1] - segment.start[1]) * LATITUDE_METERS
  const stopX = (stop[0] - segment.start[0]) * longitudeScale
  const stopY = (stop[1] - segment.start[1]) * LATITUDE_METERS
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

function exhaustiveActualPolylineOracle(
  stops: readonly ShapePatternCoordinate[],
  coordinates: readonly ShapePatternCoordinate[],
): Array<{ meanDistanceMeters: number; maxDistanceMeters: number; costMeters: number }> {
  const segments = buildActualOracleSegments(coordinates)
  const candidates = stops.map((stop) => segments.map((segment) => projectOracle(stop, segment)))
  const selected = new Array<OracleProjection>(stops.length)
  const paths: Array<{ meanDistanceMeters: number; maxDistanceMeters: number; costMeters: number }> = []

  const visit = (stopIndex: number): void => {
    if (stopIndex === selected.length) {
      const distances = selected.map((projection) => projection.distanceMeters)
      const meanDistanceMeters = distances.reduce((total, value) => total + value, 0) / distances.length
      const maxDistanceMeters = Math.max(...distances)
      paths.push({
        meanDistanceMeters,
        maxDistanceMeters,
        costMeters: meanDistanceMeters + maxDistanceMeters * 0.25,
      })
      return
    }

    for (const projection of candidates[stopIndex]) {
      if (stopIndex > 0) {
        const previous = selected[stopIndex - 1]
        if (previous.segmentIndex > projection.segmentIndex) continue
        if (
          previous.segmentIndex === projection.segmentIndex
          && previous.segmentFraction > projection.segmentFraction + 1e-12
        ) continue
      }
      selected[stopIndex] = projection
      visit(stopIndex + 1)
    }
  }

  visit(0)
  return paths.sort((a, b) => a.costMeters - b.costMeters)
}

function straightResult(
  distanceMeters: number,
  coordinate: CoordinateFactory,
  mode: 'max' | 'mean',
  options: ShapePatternMatcherOptions,
) {
  const routeUid = `ROUTE-${mode}-${distanceMeters}-${coordinate === meters ? 'base' : 'equator'}`
  const routeShape = shape('LINE', routeUid, 0, [coordinate(0, 0), coordinate(0, 100)])
  const stops = mode === 'max'
    ? [coordinate(0, 0), coordinate(distanceMeters, 100)]
    : [coordinate(distanceMeters, 0), coordinate(distanceMeters, 100)]
  return matchShapesToPatterns([pattern('PATTERN', routeUid, 0, stops)], [routeShape], options)
}

function endpointResult(
  distanceMeters: number,
  coordinate: CoordinateFactory,
  options: ShapePatternMatcherOptions,
) {
  const routeUid = `ROUTE-ENDPOINT-${distanceMeters}-${coordinate === meters ? 'base' : 'equator'}`
  const routeShape = shape('LINE', routeUid, 0, [coordinate(0, 0), coordinate(100, 0)])
  const routePattern = pattern('PATTERN', routeUid, 0, [
    coordinate(-distanceMeters, 0),
    coordinate(100 + distanceMeters, 0),
  ])
  return matchShapesToPatterns([routePattern], [routeShape], options)
}

function assertMatched(result: ReturnType<typeof matchShapesToPatterns>, expected: boolean): void {
  assert.equal(result.matches.length === 1, expected)
}

describe('third-round Direction 2 closure policy', () => {
  it('never projects stops onto the absent 400 m D-to-A gap', () => {
    const routeUid = 'ROUTE-SYNTHETIC-GAP'
    const coordinates = nearClosedCoordinates(400)
    const stops = [meters(350, 0), meters(50, 0)]
    const actualSegments = buildActualOracleSegments(coordinates)
    const oraclePaths = exhaustiveActualPolylineOracle(stops, coordinates)

    assert.equal(actualSegments.length, 3)
    assert(!actualSegments.some((segment) =>
      segment.start[0] === coordinates.at(-1)![0]
      && segment.start[1] === coordinates.at(-1)![1]
      && segment.end[0] === coordinates[0][0]
      && segment.end[1] === coordinates[0][1]))
    assert(oraclePaths.length > 0)
    assert(oraclePaths[0].meanDistanceMeters > 1)
    assert(oraclePaths[0].maxDistanceMeters > 1)
    assert(oraclePaths[0].costMeters > 1)

    const result = matchShapesToPatterns(
      [pattern('GAP-PATTERN', routeUid, 2, stops)],
      [shape('NEAR-CLOSED', routeUid, 2, coordinates)],
      { maxMeanStopDistanceMeters: 1, maxStopDistanceMeters: 1 },
    )

    assert.equal(result.matches.length, 0)
    assert.equal(result.unresolved[0]?.reason, 'near-closed-geometry-disabled')
    assert(!result.matches.some((match) => match.basis === 'geometry'))
  })

  it('fails closed for one near-closed Shape without complete identity', () => {
    const routeUid = 'ROUTE-NEAR-CLOSED-ONLY'
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, [meters(350, 0), meters(50, 0)])],
      [shape('SHAPE', routeUid, 2, nearClosedCoordinates(400))],
    )

    assert.equal(result.matches.length, 0)
    assert.equal(result.unresolved[0]?.reason, 'near-closed-geometry-disabled')
  })

  it('allows a unique complete near-closed identity only with exact-identity basis', () => {
    const routeUid = 'ROUTE-NEAR-CLOSED-IDENTITY'
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, [meters(350, 0), meters(50, 0)], 'SUB-LOOP')],
      [shape('SHAPE', routeUid, 2, nearClosedCoordinates(400), 'SUB-LOOP')],
    )

    assert.deepEqual(result.matches, [{
      patternId: 'PATTERN',
      shapeId: 'SHAPE',
      basis: 'exact-identity',
      costMeters: null,
      metrics: null,
    }])
  })

  it('fails closed for duplicate complete near-closed identities', () => {
    const routeUid = 'ROUTE-NEAR-CLOSED-DUPLICATE'
    const routePattern = pattern('PATTERN', routeUid, 2, [meters(350, 0), meters(50, 0)], 'SUB-LOOP')
    const coordinates = nearClosedCoordinates(400)
    const result = matchShapesToPatterns([routePattern], [
      shape('SHAPE-A', routeUid, 2, coordinates, 'SUB-LOOP'),
      shape('SHAPE-B', routeUid, 2, coordinates, 'SUB-LOOP'),
    ])

    assert.equal(result.matches.length, 0)
    assert.equal(result.unresolved[0]?.reason, 'near-closed-geometry-disabled')
  })

  it('does not geometry-fallback across contradictory complete identity', () => {
    const routeUid = 'ROUTE-NEAR-CLOSED-CONTRADICTORY'
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, [meters(350, 0), meters(50, 0)], 'SUB-A')],
      [shape('SHAPE', routeUid, 2, nearClosedCoordinates(400), 'SUB-B')],
    )

    assert.equal(result.matches.length, 0)
    assert.equal(result.unresolved[0]?.reason, 'contradictory-complete-identity')
  })

  it('keeps a truly closed single Shape eligible for geometry', () => {
    const routeUid = 'ROUTE-TRULY-CLOSED'
    const coordinates = trulyClosedCoordinates()
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, coordinates.slice(0, -1))],
      [shape('SHAPE', routeUid, 2, coordinates)],
    )
    const match = result.matches[0]
    const diagnostics = match?.metrics as (ShapePatternGeometryMetrics & {
      closureGapDistanceMeters?: number | null
    }) | null

    assert.equal(match?.basis, 'geometry')
    assert.equal(match?.costMeters, 0)
    assert.equal(diagnostics?.closureGapDistanceMeters, 0)
    assert(Math.abs(diagnostics!.shapeLengthMeters - 2_800) < 0.2)
    assert(diagnostics!.matchedSpanMeters <= diagnostics!.shapeLengthMeters + 1e-6)
  })

  it('fails closed for multiple truly closed geometry-only candidates', () => {
    const routeUid = 'ROUTE-TRULY-CLOSED-MULTIPLE'
    const coordinates = trulyClosedCoordinates()
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, coordinates.slice(0, -1))],
      [
        shape('SHAPE-A', routeUid, 2, coordinates),
        shape('SHAPE-B', routeUid, 2, coordinates),
      ],
    )

    assert.equal(result.matches.length, 0)
    assert.equal(result.unresolved[0]?.reason, 'tolerance-equivalent-alternatives')
  })

  it('keeps rotated and reversed truly closed encodings equivalent', () => {
    const routeUid = 'ROUTE-TRULY-CLOSED-ENCODINGS'
    const coordinates = trulyClosedCoordinates()
    const routePattern = pattern('PATTERN', routeUid, 2, [
      coordinates[2], coordinates[3], coordinates[0], coordinates[1],
    ])
    const candidates = [
      shape('BASE', routeUid, 2, coordinates),
      shape('ROTATED', routeUid, 2, rotateClosedLoop(coordinates, 2)),
      shape('REVERSED', routeUid, 2, [...coordinates].reverse()),
    ]
    const matches = candidates.map((candidate) =>
      matchShapesToPatterns([routePattern], [candidate]).matches[0]!)

    for (const match of matches) {
      assert.equal(match.basis, 'geometry')
      assert.equal(match.costMeters, 0)
      assert(match.metrics!.matchedSpanMeters <= match.metrics!.shapeLengthMeters + 1e-6)
    }
    assert(Math.abs(matches[1].metrics!.shapeLengthMeters - matches[0].metrics!.shapeLengthMeters) < 0.2)
    assert(Math.abs(matches[2].metrics!.shapeLengthMeters - matches[0].metrics!.shapeLengthMeters) < 0.2)
  })

  it('rejects an open Direction 2 Shape above the 500 m eligibility limit', () => {
    const routeUid = 'ROUTE-OPEN-LOOP'
    const result = matchShapesToPatterns(
      [pattern('PATTERN', routeUid, 2, [meters(0, 0), meters(0, 1_000)])],
      [shape('OPEN', routeUid, 2, nearClosedCoordinates(500.001))],
    )

    assert.deepEqual(result.rejectedShapes, [{ shapeId: 'OPEN', reason: 'direction-2-not-closed' }])
    assert.equal(result.matches.length, 0)
  })
})

describe('third-round floating distance threshold policy', () => {
  it('uses one inclusive policy around the 500 m Direction 2 closure boundary', () => {
    const cases: Array<{
      label: string
      gapMeters: number
      coordinate: CoordinateFactory
      eligible: boolean
      floatingExact?: boolean
    }> = [
      { label: 'just below', gapMeters: 499.999, coordinate: meters, eligible: true },
      { label: 'mathematically exact', gapMeters: 500, coordinate: equatorMeters, eligible: true },
      { label: 'floating-rounding exact', gapMeters: 500, coordinate: meters, eligible: true, floatingExact: true },
      { label: 'just above epsilon', gapMeters: 500.001, coordinate: meters, eligible: false },
    ]

    for (const testCase of cases) {
      const routeUid = `ROUTE-CLOSURE-${testCase.label}`
      const coordinates = nearClosedCoordinates(testCase.gapMeters, testCase.coordinate)
      const observedGap = approximateDistanceMeters(coordinates[0], coordinates.at(-1)!)
      if (testCase.floatingExact) {
        assert(observedGap > 500)
        assert(oracleAtOrBelowThreshold(observedGap, 500))
      }
      const result = matchShapesToPatterns(
        [pattern('PATTERN', routeUid, 2, [testCase.coordinate(450, 0), testCase.coordinate(50, 0)])],
        [shape('SHAPE', routeUid, 2, coordinates)],
      )

      if (testCase.eligible) {
        assert.equal(result.rejectedShapes.length, 0, testCase.label)
        assert.equal(result.matches.length, 0, testCase.label)
        assert.equal(result.unresolved[0]?.reason, 'near-closed-geometry-disabled', testCase.label)
      } else {
        assert.deepEqual(result.rejectedShapes, [
          { shapeId: 'SHAPE', reason: 'direction-2-not-closed' },
        ], testCase.label)
      }
    }
  })

  it('accepts max-stop-distance exact boundaries but rejects a real excess', () => {
    const options: ShapePatternMatcherOptions = {
      maxMeanStopDistanceMeters: 2_000,
      maxStopDistanceMeters: 1_000,
      maxEndpointDistanceMeters: 2_000,
    }
    const floatingDistance = approximateDistanceMeters(meters(0, 100), meters(1_000, 100))
    assert(floatingDistance > 1_000)
    assert(oracleAtOrBelowThreshold(floatingDistance, 1_000))

    assertMatched(straightResult(999.999, meters, 'max', options), true)
    assertMatched(straightResult(1_000, equatorMeters, 'max', options), true)
    assertMatched(straightResult(1_000, meters, 'max', options), true)
    assertMatched(straightResult(1_000.001, meters, 'max', options), false)
  })

  it('accepts mean-stop-distance exact boundaries but rejects a real excess', () => {
    const options: ShapePatternMatcherOptions = {
      maxMeanStopDistanceMeters: 1_000,
      maxStopDistanceMeters: 2_000,
      maxEndpointDistanceMeters: 2_000,
    }
    const floatingDistance = approximateDistanceMeters(meters(0, 0), meters(1_000, 0))
    assert(floatingDistance > 1_000)
    assert(oracleAtOrBelowThreshold(floatingDistance, 1_000))

    assertMatched(straightResult(999.999, meters, 'mean', options), true)
    assertMatched(straightResult(1_000, equatorMeters, 'mean', options), true)
    assertMatched(straightResult(1_000, meters, 'mean', options), true)
    assertMatched(straightResult(1_000.001, meters, 'mean', options), false)
  })

  it('accepts endpoint exact boundaries but rejects a real excess', () => {
    const options: ShapePatternMatcherOptions = {
      maxMeanStopDistanceMeters: 2_000,
      maxStopDistanceMeters: 2_000,
      maxEndpointDistanceMeters: 1_500,
    }
    const floatingDistance = approximateDistanceMeters(meters(0, 0), meters(1_500, 0))
    assert(floatingDistance > 1_500)
    assert(oracleAtOrBelowThreshold(floatingDistance, 1_500))

    assertMatched(endpointResult(1_499.999, meters, options), true)
    assertMatched(endpointResult(1_500, equatorMeters, options), true)
    assertMatched(endpointResult(1_500, meters, options), true)
    assertMatched(endpointResult(1_500.001, meters, options), false)
  })

  it('keeps Direction 0 and 1 behavior unchanged', () => {
    const coordinates = [meters(0, 0), meters(100, 0), meters(200, 0)]
    const forward = matchShapesToPatterns(
      [pattern('FORWARD', 'ROUTE-FORWARD', 0, coordinates)],
      [shape('SHAPE-FORWARD', 'ROUTE-FORWARD', 0, coordinates)],
    )
    const reverse = matchShapesToPatterns(
      [pattern('REVERSE', 'ROUTE-REVERSE', 1, [...coordinates].reverse())],
      [shape('SHAPE-REVERSE', 'ROUTE-REVERSE', 1, coordinates)],
    )

    assert.equal(forward.matches[0]?.basis, 'geometry')
    assert.equal(reverse.matches[0]?.basis, 'geometry')
  })
})
