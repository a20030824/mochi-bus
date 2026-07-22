import type {
  RouteShapeCandidate,
  ShapePatternCandidate,
  ShapePatternCoordinate,
} from './shape-pattern-matcher'

const BASE_LONGITUDE = 121
const BASE_LATITUDE = 25
const LONGITUDE_METERS = 111_320 * Math.cos(BASE_LATITUDE * Math.PI / 180)
const LATITUDE_METERS = 110_574

export function coordinate(longitude: number, latitude: number): ShapePatternCoordinate {
  return [longitude, latitude]
}

export function meters(x: number, y: number): ShapePatternCoordinate {
  return [BASE_LONGITUDE + x / LONGITUDE_METERS, BASE_LATITUDE + y / LATITUDE_METERS]
}

export function stop(stopUid: string, point: ShapePatternCoordinate) {
  return { stopUid, coordinate: point }
}

export function pattern(
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
    stops: points.map((point, index) => stop(`${patternId}-${index + 1}`, point)),
  }
}

export function shape(
  shapeId: string,
  routeUid: string,
  direction: 0 | 1 | 2,
  coordinates: readonly ShapePatternCoordinate[],
  subRouteUid: string | null = null,
): RouteShapeCandidate {
  return { shapeId, routeUid, subRouteUid, direction, coordinates }
}

export function tinyShapeAt(
  shapeId: string,
  routeUid: string,
  x: number,
  y: number,
): RouteShapeCandidate {
  return shape(shapeId, routeUid, 0, [meters(x - 0.01, y), meters(x + 0.01, y)])
}

export const segmentProjectionPattern = pattern(
  'SEGMENT-PATTERN',
  'ROUTE-SEGMENT',
  0,
  [coordinate(121.5080, 25.0000), coordinate(121.5120, 25.0000)],
)

export const segmentProjectionCorrectShape = shape(
  'SEGMENT-CORRECT',
  'ROUTE-SEGMENT',
  0,
  [coordinate(121.5000, 25.0000), coordinate(121.5200, 25.0000)],
)

export const segmentProjectionWrongShape = shape(
  'SEGMENT-WRONG',
  'ROUTE-SEGMENT',
  0,
  [coordinate(121.5080, 25.0009), coordinate(121.5120, 25.0009)],
)

export const reviewMatrixPatterns: readonly ShapePatternCandidate[] = [
  pattern('P1', 'ROUTE-ASSIGN', 0, [meters(67.88186962811501, 12.073448704972266), meters(67.88186962811501, 12.073448704972266)]),
  pattern('P2', 'ROUTE-ASSIGN', 0, [meters(-84.08980432357825, 19.554930267897195), meters(-84.08980432357825, 19.554930267897195)]),
]

export const reviewMatrixShapes: readonly RouteShapeCandidate[] = [
  tinyShapeAt('S1', 'ROUTE-ASSIGN', 0, 0),
  tinyShapeAt('S2', 'ROUTE-ASSIGN', 156.5, 0),
]

export const correctLoopPattern = pattern('LOOP', 'ROUTE-LOOP', 2, [
  coordinate(121.0000, 25.0000),
  coordinate(121.0100, 25.0000),
  coordinate(121.0100, 25.0100),
  coordinate(121.0000, 25.0100),
])

export const correctShortLoop = shape('CORRECT-SHORT-LOOP', 'ROUTE-LOOP', 2, [
  coordinate(121.00005, 25.00005),
  coordinate(121.01005, 25.00005),
  coordinate(121.01005, 25.01005),
  coordinate(121.00005, 25.01005),
  coordinate(121.00005, 25.00005),
])

export const wrongLongDetourLoop = shape('WRONG-LONG-DETOUR', 'ROUTE-LOOP', 2, [
  coordinate(121.0000, 25.0000),
  coordinate(121.0100, 25.0000),
  coordinate(121.0100, 25.0100),
  coordinate(121.0000, 25.0100),
  coordinate(121.1000, 25.1000),
  coordinate(121.0000, 25.0000),
])

export const openDirectionTwoShape = shape('OPEN-DIRECTION-2', 'ROUTE-LOOP', 2, [
  coordinate(121.0000, 25.0000),
  coordinate(121.0100, 25.0000),
  coordinate(121.0100, 25.0100),
  coordinate(121.0200, 25.0100),
])

export const siblingPatterns: readonly ShapePatternCandidate[] = [
  pattern('SUB-A:0', 'ROUTE-SIBLING', 0, [meters(0, 0), meters(100, 0), meters(200, 0)], 'SUB-A'),
  pattern('SUB-B:0', 'ROUTE-SIBLING', 0, [meters(0, 100), meters(100, 100), meters(200, 100)], 'SUB-B'),
]

export const siblingShapesWithIdentity: readonly RouteShapeCandidate[] = [
  shape('SHAPE-A', 'ROUTE-SIBLING', 0, [meters(0, 0), meters(100, 0), meters(200, 0)], 'SUB-A'),
  shape('SHAPE-B', 'ROUTE-SIBLING', 0, [meters(0, 100), meters(100, 100), meters(200, 100)], 'SUB-B'),
]

export const siblingShapesWithoutIdentity: readonly RouteShapeCandidate[] = siblingShapesWithIdentity.map(
  ({ subRouteUid: _subRouteUid, ...candidate }) => candidate,
)

export const shapeWithConsecutiveDuplicates = shape('CONSECUTIVE-DUPLICATES', 'ROUTE-DUP', 0, [
  meters(0, 0), meters(0, 0), meters(100, 0), meters(200, 0),
])

export const allDuplicateShape = shape('ALL-DUPLICATE', 'ROUTE-DUP', 0, [
  meters(0, 0), meters(0, 0), meters(0, 0),
])

export const invalidCoordinateShape = shape('INVALID-COORDINATE', 'ROUTE-DUP', 0, [
  meters(0, 0), coordinate(Number.NaN, 25),
])
