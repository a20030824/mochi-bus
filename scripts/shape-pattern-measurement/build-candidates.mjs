import { contentHash, stableStringify } from './util.mjs'

const SUPPORTED_DIRECTIONS = new Set([0, 1, 2])

export function buildCandidatePartitions(rawBundle) {
  const partitions = new Map()
  const rejected = []
  for (const source of [...(rawBundle.sources ?? [])].sort(compareSource)) {
    const sourceScope = source.scope === 'intercity' ? 'intercity' : 'city'
    const city = sourceScope === 'city' ? source.city : null
    const patternRecords = normalizeRecords(source.stopOfRoute)
      .map((item) => buildPatternRecord(item, sourceScope, city))
      .sort(compareCandidateRecord)
    const shapeRecords = normalizeRecords(source.shapes)
      .map((item) => buildShapeRecord(item, sourceScope, city))
      .sort(compareCandidateRecord)

    assignDuplicateOrdinals(patternRecords, 'pattern')
    assignDuplicateOrdinals(shapeRecords, 'shape')

    for (const record of patternRecords) {
      if (!record.validPartition) {
        rejected.push({ kind: 'pattern', sourceScope, city, reason: record.reason, sourceHash: record.sourceHash })
        continue
      }
      partitionFor(partitions, sourceScope, city, record.routeUid, record.direction).patterns.push(record.candidate)
    }
    for (const record of shapeRecords) {
      if (!record.validPartition) {
        rejected.push({ kind: 'shape', sourceScope, city, reason: record.reason, sourceHash: record.sourceHash })
        continue
      }
      partitionFor(partitions, sourceScope, city, record.routeUid, record.direction).shapes.push(record.candidate)
    }
  }

  const result = [...partitions.values()].map(finalizePartition).sort(comparePartition)
  return { partitions: result, rejected: rejected.sort(compareRejected) }
}

function normalizeRecords(value) {
  return Array.isArray(value) ? value : []
}

function buildPatternRecord(item, sourceScope, city) {
  const routeUid = text(item?.RouteUID)
  const direction = directionValue(item?.Direction)
  const subRouteUid = nullableText(item?.SubRouteUID)
  const stops = Array.isArray(item?.Stops) ? item.Stops.map((stop) => ({
    stopUid: text(stop?.StopUID) || undefined,
    coordinate: [Number(stop?.StopPosition?.PositionLon), Number(stop?.StopPosition?.PositionLat)],
  })) : []
  const normalized = { routeUid, direction, subRouteUid, stops }
  const sourceHash = contentHash(normalized)
  const record = {
    kind: 'pattern', sourceScope, city, routeUid, direction, subRouteUid, sourceHash,
    sortKey: stableStringify(normalized), validPartition: Boolean(routeUid && direction !== null),
    reason: routeUid ? (direction === null ? 'unsupported-direction' : null) : 'missing-route-uid',
    candidate: null,
  }
  record.makeCandidate = (ordinal) => ({
    patternId: `${scopePrefix(sourceScope, city)}:pattern:${sourceHash.slice(0, 20)}:${ordinal}`,
    routeUid,
    subRouteUid,
    direction,
    stops,
  })
  return record
}

function buildShapeRecord(item, sourceScope, city) {
  const routeUid = text(item?.RouteUID)
  const direction = directionValue(item?.Direction)
  const subRouteUid = nullableText(item?.SubRouteUID)
  const decoded = extractShapeCoordinates(item)
  const normalized = { routeUid, direction, subRouteUid, coordinates: decoded.coordinates }
  const sourceHash = contentHash(normalized)
  const record = {
    kind: 'shape', sourceScope, city, routeUid, direction, subRouteUid, sourceHash,
    sortKey: stableStringify(normalized), validPartition: Boolean(routeUid && direction !== null),
    reason: routeUid ? (direction === null ? 'unsupported-direction' : null) : 'missing-route-uid',
    candidate: null,
  }
  record.makeCandidate = (ordinal) => ({
    shapeId: `${scopePrefix(sourceScope, city)}:shape:${sourceHash.slice(0, 20)}:${ordinal}`,
    routeUid,
    subRouteUid,
    direction,
    coordinates: decoded.coordinates,
    measurement: {
      rawCoordinateCount: decoded.rawCoordinateCount,
      decodeFailure: decoded.failure,
      updateTime: nullableText(item?.UpdateTime),
    },
  })
  return record
}

function assignDuplicateOrdinals(records) {
  const counts = new Map()
  for (const record of records) {
    const ordinal = (counts.get(record.sourceHash) ?? 0) + 1
    counts.set(record.sourceHash, ordinal)
    record.candidate = record.makeCandidate(ordinal)
  }
}

function partitionFor(partitions, sourceScope, city, routeUid, direction) {
  const key = `${sourceScope}\0${city ?? ''}\0${routeUid}\0${direction}`
  let partition = partitions.get(key)
  if (!partition) {
    partition = { key, sourceScope, city, routeUid, direction, patterns: [], shapes: [] }
    partitions.set(key, partition)
  }
  return partition
}

function finalizePartition(partition) {
  partition.patterns.sort((a, b) => a.patternId.localeCompare(b.patternId))
  partition.shapes.sort((a, b) => a.shapeId.localeCompare(b.shapeId))
  const patternIdentities = identityCounts(partition.patterns)
  const shapeIdentities = identityCounts(partition.shapes)
  const duplicateIdentityCount = [...patternIdentities.values(), ...shapeIdentities.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0)
  const completePatternIdentities = new Set([...patternIdentities.keys()].filter(Boolean))
  const completeShapeIdentities = new Set([...shapeIdentities.keys()].filter(Boolean))
  const contradictoryIdentityCount = [...completePatternIdentities]
    .filter((identity) => completeShapeIdentities.size > 0 && !completeShapeIdentities.has(identity)).length
  return {
    ...partition,
    partitionId: contentHash({
      sourceScope: partition.sourceScope, city: partition.city,
      routeUid: partition.routeUid, direction: partition.direction,
    }).slice(0, 24),
    stats: {
      patternCount: partition.patterns.length,
      shapeCount: partition.shapes.length,
      minSideCount: Math.min(partition.patterns.length, partition.shapes.length),
      completeIdentityCount: [...patternIdentities.keys()].filter(Boolean).length
        + [...shapeIdentities.keys()].filter(Boolean).length,
      duplicateIdentityCount,
      contradictoryIdentityCount,
      candidateMultiplicity: partition.patterns.length * partition.shapes.length,
    },
  }
}

function identityCounts(candidates) {
  const counts = new Map()
  for (const candidate of candidates) {
    const identity = candidate.subRouteUid ? `${candidate.routeUid}\0${candidate.direction}\0${candidate.subRouteUid}` : ''
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
  }
  return counts
}

export function extractShapeCoordinates(item) {
  const direct = item?.Coordinates ?? item?.Geometry?.Coordinates ?? item?.Shape?.Coordinates
  if (Array.isArray(direct)) {
    const coordinates = direct.map((point) => [Number(point?.[0]), Number(point?.[1])])
    return { coordinates, rawCoordinateCount: direct.length, failure: null }
  }
  if (typeof item?.EncodedPolyline === 'string') {
    try {
      const coordinates = decodePolyline(item.EncodedPolyline)
      return { coordinates, rawCoordinateCount: coordinates.length, failure: null }
    } catch {
      return { coordinates: [], rawCoordinateCount: 0, failure: 'invalid-encoded-polyline' }
    }
  }
  return { coordinates: [], rawCoordinateCount: 0, failure: 'missing-coordinates' }
}

export function decodePolyline(encoded) {
  let index = 0
  let latitude = 0
  let longitude = 0
  const coordinates = []
  while (index < encoded.length) {
    const lat = decodeComponent(encoded, index)
    index = lat.next
    const lon = decodeComponent(encoded, index)
    index = lon.next
    latitude += lat.delta
    longitude += lon.delta
    coordinates.push([longitude / 1e5, latitude / 1e5])
  }
  return coordinates
}

function decodeComponent(encoded, start) {
  let index = start
  let result = 0
  let shift = 0
  while (index < encoded.length) {
    const value = encoded.charCodeAt(index) - 63
    if (value < 0 || value > 63) throw new Error('invalid polyline character')
    index += 1
    result |= (value & 0x1f) << shift
    shift += 5
    if (value < 0x20) {
      const delta = (result & 1) ? ~(result >> 1) : (result >> 1)
      return { delta, next: index }
    }
    if (shift > 30) throw new Error('polyline component overflow')
  }
  throw new Error('truncated polyline')
}

function scopePrefix(sourceScope, city) {
  return sourceScope === 'intercity' ? 'intercity' : `city-${city}`
}
function text(value) { return typeof value === 'string' ? value.trim() : '' }
function nullableText(value) { const normalized = text(value); return normalized || null }
function directionValue(value) { const number = Number(value); return SUPPORTED_DIRECTIONS.has(number) ? number : null }
function compareSource(a, b) { return `${a.scope}\0${a.city ?? ''}`.localeCompare(`${b.scope}\0${b.city ?? ''}`) }
function compareCandidateRecord(a, b) { return a.sortKey.localeCompare(b.sortKey) || a.sourceHash.localeCompare(b.sourceHash) }
function comparePartition(a, b) { return a.key.localeCompare(b.key) }
function compareRejected(a, b) { return stableStringify(a).localeCompare(stableStringify(b)) }
