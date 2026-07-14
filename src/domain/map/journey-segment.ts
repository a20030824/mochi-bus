import { matchStopsToShape, type SequencedPosition, type ShapePosition } from './shape-matcher'

const CIRCULAR_SHAPE_MAX_GAP_METERS = 500

/** Return only the portion of a route shape travelled between two stops. */
export function getJourneySegmentCoordinates(
  shape: ShapePosition[],
  stops: SequencedPosition[],
  boardSequence: number | null | undefined,
  alightSequence: number | null | undefined,
): ShapePosition[] | null {
  if (shape.length < 2 || !stops.length || boardSequence == null || alightSequence == null) return null

  const board = stops.find((stop) => stop.sequence === boardSequence)
  const alight = stops.find((stop) => stop.sequence === alightSequence)
  if (!board || !alight) return null

  const matchingShape = unwrapCircularShape(shape)
  const matches = matchStopsToShape(stops, matchingShape.coordinates)
  const boardIndex = matches.get(boardSequence) ?? nearestCoordinateIndex(matchingShape.coordinates, board.coordinates)
  const alightIndex = matches.get(alightSequence) ?? nearestCoordinateIndex(matchingShape.coordinates, alight.coordinates)
  const start = Math.min(boardIndex, alightIndex)
  const end = Math.max(boardIndex, alightIndex)
  if (matchingShape.maxSpan !== null && end - start > matchingShape.maxSpan) return null
  const segment = matchingShape.coordinates.slice(start, end + 1)
  if (segment.length < 2) return null

  return segment.map(([longitude, latitude]) => [longitude, latitude])
}

function unwrapCircularShape(shape: ShapePosition[]): {
  coordinates: ShapePosition[]
  maxSpan: number | null
} {
  if (!isCircularShape(shape)) return { coordinates: shape, maxSpan: null }

  const first = shape[0]
  const last = shape[shape.length - 1]
  const closesExactly = first[0] === last[0] && first[1] === last[1]
  // Some TDX loop shapes start at a geometry point that falls in the middle of the
  // stop sequence. A second lap lets the monotonic stop matcher cross that seam once.
  const nextLap = closesExactly ? shape.slice(1) : [first, ...shape.slice(1)]
  return {
    coordinates: [...shape, ...nextLap],
    maxSpan: nextLap.length,
  }
}

function isCircularShape(shape: ShapePosition[]): boolean {
  if (shape.length < 4) return false
  return approximateDistanceMeters(shape[0], shape[shape.length - 1]) <= CIRCULAR_SHAPE_MAX_GAP_METERS
}

function approximateDistanceMeters(a: ShapePosition, b: ShapePosition): number {
  const latitude = (a[1] + b[1]) * Math.PI / 360
  const longitudeMeters = (a[0] - b[0]) * Math.cos(latitude) * 111_320
  const latitudeMeters = (a[1] - b[1]) * 110_574
  return Math.hypot(longitudeMeters, latitudeMeters)
}

export function nearestCoordinateIndex(coordinates: ShapePosition[], target: ShapePosition): number {
  let nearest = 0
  let nearestDistance = Number.POSITIVE_INFINITY
  coordinates.forEach(([longitude, latitude], index) => {
    const deltaLongitude = longitude - target[0]
    const deltaLatitude = latitude - target[1]
    const distance = deltaLongitude * deltaLongitude + deltaLatitude * deltaLatitude
    if (distance < nearestDistance) {
      nearest = index
      nearestDistance = distance
    }
  })
  return nearest
}
