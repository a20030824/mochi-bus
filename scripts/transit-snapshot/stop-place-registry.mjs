const DEFAULT_GRID_DEGREES = 0.002

export function createStopPlaceRegistry({
  city,
  normalizeName,
  hash,
  distanceMeters,
  mergeRadiusMeters = 200,
  warningDistanceMeters = 50,
  gridDegrees = DEFAULT_GRID_DEGREES,
}) {
  if (!city || typeof normalizeName !== 'function' || typeof hash !== 'function'
    || typeof distanceMeters !== 'function') {
    throw new Error('Invalid stop/place registry configuration')
  }

  const stops = new Map()
  const places = new Map()
  const patternStops = []
  const placeGrid = new Map()
  const observations = new Map()
  const placeGridKey = (normalized, latCell, lonCell) => `${normalized}:${latCell}:${lonCell}`

  function findExistingPlace(normalized, lat, lon) {
    const latCell = Math.floor(lat / gridDegrees)
    const lonCell = Math.floor(lon / gridDegrees)
    for (let dLat = -1; dLat <= 1; dLat += 1) {
      for (let dLon = -1; dLon <= 1; dLon += 1) {
        const bucket = placeGrid.get(placeGridKey(normalized, latCell + dLat, lonCell + dLon))
        const match = bucket?.find((place) => distanceMeters(lat, lon, place.lat, place.lon) <= mergeRadiusMeters)
        if (match) return match
      }
    }
    return undefined
  }

  function indexPlace(place) {
    const key = placeGridKey(place.normalized, Math.floor(place.lat / gridDegrees), Math.floor(place.lon / gridDegrees))
    const bucket = placeGrid.get(key)
    if (bucket) bucket.push(place)
    else placeGrid.set(key, [place])
  }

  function addOccurrence({ patternId, stop }) {
    const stopUid = stop?.StopUID
    const name = stop?.StopName?.Zh_tw
    const lat = stop?.StopPosition?.PositionLat
    const lon = stop?.StopPosition?.PositionLon
    if (!patternId || !stopUid || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      throw new Error('Invalid stop occurrence')
    }
    const normalized = normalizeName(name)
    const canonical = stops.get(stopUid)

    // City StopOfRoute is loaded before InterCity. The first observation owns
    // the canonical StopUID record; later route occurrences must reuse its placeId.
    if (canonical) {
      const observation = observations.get(stopUid)
      observation.occurrences += 1
      observation.normalizedNameMismatch ||= canonical.normalized !== normalized
      observation.maxDistanceMeters = Math.max(
        observation.maxDistanceMeters,
        distanceMeters(canonical.lat, canonical.lon, lat, lon),
      )
      patternStops.push({
        patternId,
        stopUid,
        placeId: canonical.placeId,
        sequence: stop.StopSequence ?? 0,
      })
      return canonical
    }

    const existingPlace = findExistingPlace(normalized, lat, lon)
    const placeId = existingPlace?.id ?? `${city}:${hash(`${normalized}:${lat.toFixed(4)}:${lon.toFixed(4)}`)}`
    const canonicalStop = { uid: stopUid, name, normalized, lat, lon, placeId }
    stops.set(stopUid, canonicalStop)
    observations.set(stopUid, {
      stopUid,
      occurrences: 1,
      canonicalPlaceId: placeId,
      normalizedNameMismatch: false,
      maxDistanceMeters: 0,
    })
    if (!existingPlace) {
      const place = { id: placeId, name, normalized, lat, lon }
      places.set(placeId, place)
      indexPlace(place)
    }
    patternStops.push({ patternId, stopUid, placeId, sequence: stop.StopSequence ?? 0 })
    return canonicalStop
  }

  function duplicateWarnings() {
    return [...observations.values()]
      .filter((item) => item.occurrences > 1
        && (item.normalizedNameMismatch || item.maxDistanceMeters > warningDistanceMeters))
      .sort((left, right) => left.stopUid.localeCompare(right.stopUid))
      .map((item) => Object.freeze({
        stopUid: item.stopUid,
        occurrences: item.occurrences,
        canonicalPlaceId: item.canonicalPlaceId,
        normalizedNameMismatch: item.normalizedNameMismatch,
        maxDistanceMeters: Math.round(item.maxDistanceMeters),
      }))
  }

  return Object.freeze({ stops, places, patternStops, addOccurrence, duplicateWarnings })
}
