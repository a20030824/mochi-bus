export type ShapePosition = [number, number]

export type SequencedPosition = {
  sequence: number
  coordinates: ShapePosition
}

export function matchStopsToShape(
  stops: SequencedPosition[],
  shape: ShapePosition[],
): Map<number, number> {
  if (!stops.length || !shape.length) return new Map()
  const orderedStops = [...stops].sort((a, b) => a.sequence - b.sequence)
  const forward = matchMonotonically(orderedStops, shape)
  const reversedShape = [...shape].reverse()
  const reversed = matchMonotonically(orderedStops, reversedShape)

  if (forward.cost <= reversed.cost) {
    return new Map(orderedStops.map((stop, index) => [stop.sequence, forward.indices[index]]))
  }
  return new Map(orderedStops.map((stop, index) => [
    stop.sequence,
    shape.length - 1 - reversed.indices[index],
  ]))
}

function matchMonotonically(stops: SequencedPosition[], shape: ShapePosition[]) {
  const width = shape.length
  const parents = stops.map(() => new Int32Array(width))
  let previous = shape.map((point) => squaredDistance(stops[0].coordinates, point))

  for (let stopIndex = 1; stopIndex < stops.length; stopIndex += 1) {
    const current = new Array<number>(width)
    let bestCost = Number.POSITIVE_INFINITY
    let bestIndex = 0
    for (let shapeIndex = 0; shapeIndex < width; shapeIndex += 1) {
      if (previous[shapeIndex] < bestCost) {
        bestCost = previous[shapeIndex]
        bestIndex = shapeIndex
      }
      current[shapeIndex] = bestCost + squaredDistance(stops[stopIndex].coordinates, shape[shapeIndex])
      parents[stopIndex][shapeIndex] = bestIndex
    }
    previous = current
  }

  let finalIndex = 0
  for (let index = 1; index < width; index += 1) {
    if (previous[index] < previous[finalIndex]) finalIndex = index
  }
  const indices = new Array<number>(stops.length)
  indices[stops.length - 1] = finalIndex
  for (let stopIndex = stops.length - 1; stopIndex > 0; stopIndex -= 1) {
    indices[stopIndex - 1] = parents[stopIndex][indices[stopIndex]]
  }
  return { indices, cost: previous[finalIndex] }
}

function squaredDistance(a: ShapePosition, b: ShapePosition): number {
  const latitude = (a[1] + b[1]) * Math.PI / 360
  const longitudeDelta = (a[0] - b[0]) * Math.cos(latitude)
  const latitudeDelta = a[1] - b[1]
  return longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta
}
