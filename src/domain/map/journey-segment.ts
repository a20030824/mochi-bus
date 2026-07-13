import { matchStopsToShape, type SequencedPosition, type ShapePosition } from './shape-matcher'

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

  const matches = matchStopsToShape(stops, shape)
  const boardIndex = matches.get(boardSequence) ?? nearestCoordinateIndex(shape, board.coordinates)
  const alightIndex = matches.get(alightSequence) ?? nearestCoordinateIndex(shape, alight.coordinates)
  const start = Math.min(boardIndex, alightIndex)
  const end = Math.max(boardIndex, alightIndex)
  const segment = shape.slice(start, end + 1)
  if (segment.length < 2) return null

  return segment.map(([longitude, latitude]) => [longitude, latitude])
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
