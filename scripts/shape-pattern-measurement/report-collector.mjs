import { stableStringify } from './util.mjs'

export function createInstrumentationCollector(partition) {
  const pairMap = new Map()
  let currentPair = null
  const assignment = {
    bestCount: 0, forcedMatchCount: 0, forcedUnmatchedCount: 0,
    bestTimeMs: 0, forcedMatchTimeMs: 0, forcedUnmatchedTimeMs: 0, activeMaskPeak: 0,
  }
  const observe = (event, payload = {}) => {
    if (event === 'pair-start') {
      currentPair = `${payload.patternId}\0${payload.shapeId}`
      pairMap.set(currentPair, {
        patternId: payload.patternId, shapeId: payload.shapeId,
        projectionCandidateCount: 0, peakFrontierWidth: 0, retainedNodeCount: 0,
        parentNodeCount: 0, pathKeyApproximateBytes: 0, forwardTimeMs: 0,
        reverseTimeMs: 0, costObjectiveSolveTimeMs: 0, spanObjectiveSolveTimeMs: 0,
        pairTimeMs: 0, compatible: false, instrumented: true,
      })
      return
    }
    if (event === 'pair-end') {
      const record = pairMap.get(currentPair)
      if (record) {
        record.pairTimeMs = payload.elapsedMs
        record.compatible = payload.compatible
      }
      currentPair = null
      return
    }
    if (event === 'orientation-end' && currentPair) {
      const record = pairMap.get(currentPair)
      if (record) record[payload.orientation === 'forward' ? 'forwardTimeMs' : 'reverseTimeMs'] += payload.elapsedMs
      return
    }
    if (event === 'projection-start' && currentPair) {
      const record = pairMap.get(currentPair)
      if (record) record.projectionCandidateCount += payload.candidateCount
      return
    }
    if (event === 'projection-layer' && currentPair) {
      const record = pairMap.get(currentPair)
      if (record) {
        record.peakFrontierWidth = Math.max(record.peakFrontierWidth, payload.frontierWidth)
        record.retainedNodeCount += payload.retainedNodes
        record.parentNodeCount += payload.parentNodeCount
        record.pathKeyApproximateBytes += payload.pathKeyChars * 2
      }
      return
    }
    if (event === 'projection-end' && currentPair) {
      const record = pairMap.get(currentPair)
      if (record) {
        const field = payload.objective === 'span' ? 'spanObjectiveSolveTimeMs' : 'costObjectiveSolveTimeMs'
        record[field] += payload.elapsedMs
      }
      return
    }
    if (event === 'assignment-solve-end') {
      if (payload.kind === 'best') {
        assignment.bestCount += 1
        assignment.bestTimeMs += payload.elapsedMs
      } else if (payload.kind === 'forced-match') {
        assignment.forcedMatchCount += 1
        assignment.forcedMatchTimeMs += payload.elapsedMs
      } else {
        assignment.forcedUnmatchedCount += 1
        assignment.forcedUnmatchedTimeMs += payload.elapsedMs
      }
      return
    }
    if (event === 'assignment-state') {
      assignment.activeMaskPeak = Math.max(assignment.activeMaskPeak, payload.activeMaskCount)
    }
  }
  return {
    observe,
    finish: () => {
      if (currentPair) throw new Error(`Unclosed instrumentation pair in ${partition.partitionId}`)
    },
    snapshot: () => ({
      pairs: [...pairMap.values()].sort(comparePairRecord),
      assignment: { ...assignment },
      deterministic: {
        pairs: [...pairMap.values()].map(({
          pairTimeMs: _a, forwardTimeMs: _b, reverseTimeMs: _c,
          costObjectiveSolveTimeMs: _d, spanObjectiveSolveTimeMs: _e, ...rest
        }) => rest),
        assignment: {
          ...assignment,
          bestTimeMs: 0,
          forcedMatchTimeMs: 0,
          forcedUnmatchedTimeMs: 0,
        },
      },
    }),
  }
}

export function mergePairRecords(partition, measuredPairs) {
  const measured = new Map(measuredPairs.map((pair) => [`${pair.patternId}\0${pair.shapeId}`, pair]))
  const records = []
  for (const pattern of partition.patterns) {
    for (const shape of partition.shapes) {
      const key = `${pattern.patternId}\0${shape.shapeId}`
      const normalized = normalizeCoordinates(shape.coordinates)
      const closure = classifyClosure(shape.direction, normalized)
      const structurallyScoreable = pattern.stops.length > 0
        && pattern.stops.every((stop) => Array.isArray(stop.coordinate) && stop.coordinate.every(Number.isFinite))
        && normalized.length >= 2
        && identitiesCompatible(pattern, shape)
        && closure.classification !== 'near-closed'
        && closure.classification !== 'open-or-invalid'
      const metrics = measured.get(key) ?? (structurallyScoreable ? emptyPairMetrics(pattern, shape) : null)
      if (!metrics) continue
      records.push({
        partitionId: partition.partitionId,
        patternId: pattern.patternId,
        shapeId: shape.shapeId,
        stopCount: pattern.stops.length,
        rawCoordinateCount: shape.measurement?.rawCoordinateCount ?? shape.coordinates.length,
        normalizedCoordinateCount: normalized.length,
        segmentCount: countSegments(normalized),
        direction2UnwrappedSegmentCount: shape.direction === 2 && closure.classification === 'truly-closed'
          ? countSegments(normalized) * 2 : 0,
        duplicateCoordinateRemovalCount: Math.max(0, shape.coordinates.length - normalized.length),
        closureClassification: closure.classification,
        closureGapDistanceMeters: closure.gapDistanceMeters,
        ...metrics,
      })
    }
  }
  return records.sort(comparePairRecord)
}

function emptyPairMetrics(pattern, shape) {
  return {
    patternId: pattern.patternId,
    shapeId: shape.shapeId,
    projectionCandidateCount: 0,
    peakFrontierWidth: 0,
    retainedNodeCount: 0,
    parentNodeCount: 0,
    pathKeyApproximateBytes: 0,
    forwardTimeMs: 0,
    reverseTimeMs: 0,
    costObjectiveSolveTimeMs: 0,
    spanObjectiveSolveTimeMs: 0,
    pairTimeMs: 0,
    compatible: null,
    instrumented: false,
  }
}

function identitiesCompatible(pattern, shape) {
  return pattern.routeUid === shape.routeUid
    && pattern.direction === shape.direction
    && !(pattern.subRouteUid && shape.subRouteUid && pattern.subRouteUid !== shape.subRouteUid)
}

export function normalizeCoordinates(coordinates) {
  const result = []
  for (const point of coordinates) {
    if (!Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])) continue
    if (!result.length || result.at(-1)[0] !== point[0] || result.at(-1)[1] !== point[1]) {
      result.push([point[0], point[1]])
    }
  }
  return result
}

export function classifyClosure(direction, coordinates) {
  if (direction !== 2) return { classification: 'not-direction-2', gapDistanceMeters: null }
  if (coordinates.length < 2) return { classification: 'open-or-invalid', gapDistanceMeters: 0 }
  const gapDistanceMeters = distanceMeters(coordinates[0], coordinates.at(-1))
  if (gapDistanceMeters <= 1e-9) return { classification: 'truly-closed', gapDistanceMeters }
  if (gapDistanceMeters <= 500) return { classification: 'near-closed', gapDistanceMeters }
  return { classification: 'open-or-invalid', gapDistanceMeters }
}

function countSegments(coordinates) {
  return Math.max(0, coordinates.length - 1)
}

function distanceMeters(a, b) {
  const latitude = (a[1] + b[1]) / 2 * Math.PI / 180
  return Math.hypot(
    (a[0] - b[0]) * Math.cos(latitude) * 111_320,
    (a[1] - b[1]) * 110_574,
  )
}

export function comparePairRecord(a, b) {
  return `${a.partitionId ?? ''}\0${a.patternId}\0${a.shapeId}`
    .localeCompare(`${b.partitionId ?? ''}\0${b.patternId}\0${b.shapeId}`)
}

export function assertCollectorsDeterministic(collectors, partitionId) {
  for (const collector of collectors.slice(1)) {
    if (stableStringify(collector.deterministic) !== stableStringify(collectors[0].deterministic)) {
      throw new Error(`Instrumentation counters are not deterministic for partition ${partitionId}`)
    }
  }
}
