export class SnapshotValidationError extends Error {
  constructor(issues) {
    super(`Snapshot validation failed:\n- ${issues.join('\n- ')}`)
    this.name = 'SnapshotValidationError'
    this.issues = issues
  }
}

export function validateSnapshot(snapshot, previousState = null) {
  const issues = []
  const counts = {
    routes: snapshot.routes.size,
    patterns: snapshot.patterns.length,
    stops: snapshot.stops.size,
    places: snapshot.places.size,
    patternStops: snapshot.patternStops.length,
    schedules: snapshot.schedules.size,
    placeBundles: snapshot.placeBundles.size,
  }

  for (const [name, count] of Object.entries(counts)) {
    if (!Number.isInteger(count) || count <= 0) issues.push(`${name} must not be empty`)
  }
  compareWithPrevious(counts, previousState?.counts, issues)

  const patternIds = new Set()
  for (const pattern of snapshot.patterns) {
    if (!pattern.id || patternIds.has(pattern.id)) issues.push(`duplicate or empty pattern id: ${pattern.id ?? ''}`)
    patternIds.add(pattern.id)
    if (!snapshot.routes.has(pattern.routeUid)) issues.push(`pattern ${pattern.id} references missing route ${pattern.routeUid}`)
    validateLineString(pattern.id, pattern.shapeFeature, issues)
  }

  for (const [stopUid, stop] of snapshot.stops) {
    if (!stopUid || !snapshot.places.has(stop.placeId)) {
      issues.push(`stop ${stopUid || '(empty)'} references missing place ${stop.placeId ?? ''}`)
    }
    validateCoordinate(`stop ${stopUid}`, stop.lat, stop.lon, issues)
  }
  for (const [placeId, place] of snapshot.places) {
    validateCoordinate(`place ${placeId}`, place.lat, place.lon, issues)
  }

  const sequences = new Set()
  for (const item of snapshot.patternStops) {
    if (!patternIds.has(item.patternId)) issues.push(`pattern stop references missing pattern ${item.patternId}`)
    if (!snapshot.stops.has(item.stopUid)) issues.push(`pattern stop references missing stop ${item.stopUid}`)
    if (!snapshot.places.has(item.placeId)) issues.push(`pattern stop references missing place ${item.placeId}`)
    if (!Number.isInteger(item.sequence) || item.sequence < 0) {
      issues.push(`pattern ${item.patternId} has invalid stop sequence ${item.sequence}`)
    }
    const key = `${item.patternId}:${item.sequence}`
    if (sequences.has(key)) issues.push(`pattern ${item.patternId} has duplicate stop sequence ${item.sequence}`)
    sequences.add(key)
  }

  for (const routeUid of snapshot.routes.keys()) {
    if (!snapshot.schedules.has(routeUid)) issues.push(`missing schedule artifact for route ${routeUid}`)
  }
  for (const placeId of snapshot.places.keys()) {
    const bundle = snapshot.placeBundles.get(placeId)
    if (!bundle) issues.push(`missing place bundle for ${placeId}`)
    else if (!Array.isArray(bundle.routes) || bundle.routes.length === 0) issues.push(`place bundle ${placeId} has no routes`)
  }

  validateNetwork(snapshot, patternIds, issues)
  if (issues.length) throw new SnapshotValidationError(issues)
  return { valid: true, counts }
}

function compareWithPrevious(counts, previousCounts, issues) {
  if (!previousCounts) return
  for (const name of ['routes', 'patterns', 'stops', 'places']) {
    const previous = previousCounts[name]
    if (!Number.isInteger(previous) || previous <= 0) continue
    if (counts[name] < Math.floor(previous * 0.6)) {
      issues.push(`${name} dropped from ${previous} to ${counts[name]} (over 40%)`)
    }
  }
}

function validateCoordinate(label, latitude, longitude, issues) {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < 20 || latitude > 27 || longitude < 117 || longitude > 123.5) {
    issues.push(`${label} has invalid Taiwan coordinate ${latitude},${longitude}`)
  }
}

function validateLineString(patternId, feature, issues) {
  const coordinates = feature?.geometry?.type === 'LineString' ? feature.geometry.coordinates : null
  if (!Array.isArray(coordinates) || coordinates.length < 2) {
    issues.push(`pattern ${patternId} has an invalid LineString`)
    return
  }
  for (const coordinate of coordinates) {
    if (!Array.isArray(coordinate) || coordinate.length < 2) {
      issues.push(`pattern ${patternId} has a malformed shape coordinate`)
      return
    }
    validateCoordinate(`pattern ${patternId}`, coordinate[1], coordinate[0], issues)
  }
}

function validateNetwork(snapshot, patternIds, issues) {
  const network = snapshot.network
  if (network?.schemaVersion !== 1 || network.city !== snapshot.city || network.version !== snapshot.version) {
    issues.push('network metadata does not match the generated snapshot')
    return
  }
  if (!Array.isArray(network.routes) || network.routes.length !== snapshot.patterns.length) {
    issues.push(`network routes count does not match patterns (${network?.routes?.length ?? 'missing'} vs ${snapshot.patterns.length})`)
  } else {
    for (const route of network.routes) {
      if (!patternIds.has(route.variantKey)) issues.push(`network references missing pattern ${route.variantKey}`)
      validateLineString(route.variantKey, route.shape, issues)
    }
  }
  if (!Array.isArray(network.places) || network.places.length !== snapshot.places.size) {
    issues.push(`network places count does not match places (${network?.places?.length ?? 'missing'} vs ${snapshot.places.size})`)
  }
}
