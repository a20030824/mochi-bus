export function decodePolyline(encoded: string): Array<[number, number]> {
  const points: Array<[number, number]> = []
  let index = 0
  let latitude = 0
  let longitude = 0

  while (index < encoded.length) {
    const lat = decodeValue(encoded, index)
    index = lat.nextIndex
    latitude += lat.value

    const lon = decodeValue(encoded, index)
    index = lon.nextIndex
    longitude += lon.value
    points.push([latitude / 1e5, longitude / 1e5])
  }

  return points
}

export function polylineToGeoJSONCoordinates(encoded: string): Array<[number, number]> {
  return decodePolyline(encoded).map(([lat, lon]) => [lon, lat])
}

function decodeValue(encoded: string, startIndex: number): { value: number; nextIndex: number } {
  let index = startIndex
  let result = 0
  let shift = 0
  let byte: number

  do {
    if (index >= encoded.length) throw new Error('Invalid encoded polyline')
    byte = encoded.charCodeAt(index++) - 63
    result |= (byte & 0x1f) << shift
    shift += 5
  } while (byte >= 0x20)

  return {
    value: result & 1 ? ~(result >> 1) : result >> 1,
    nextIndex: index,
  }
}
