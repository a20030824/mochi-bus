import { classifyClosure, normalizeCoordinates } from './report-collector.mjs'
import { contentHash, distribution, omitNondeterministic, stableStringify } from './util.mjs'

export function deterministicContentHash(report) {
  return contentHash(omitNondeterministic({
    schemaVersion: report.metadata.schemaVersion,
    repositoryMainSha: report.metadata.repositoryMainSha,
    matcherSourcePath: report.metadata.matcherSourcePath,
    matcherSourceSha256: report.metadata.matcherSourceSha256,
    matcherSourceGitBlobSha1: report.metadata.matcherSourceGitBlobSha1,
    harnessVersion: report.metadata.harnessVersion,
    selectedCities: report.metadata.selectedCities,
    includeIntercity: report.metadata.includeIntercity,
    endpointContentHashes: report.metadata.endpointContentHashes,
    tdxPayloadMaxUpdateTime: report.metadata.tdxPayloadMaxUpdateTime,
    mode: report.metadata.mode,
    partitions: report.partitions,
    pairs: report.pairs,
    outcomes: report.outcomes,
  }))
}

export function buildSummary(partitions, pairs) {
  const fields = {
    patternCount: partitions.map((item) => item.patternCount),
    shapeCount: partitions.map((item) => item.shapeCount),
    minSideCount: partitions.map((item) => item.minSideCount),
    compatibleEdgeCount: partitions.map((item) => item.compatibleEdgeCount),
    compatibleEdgeDensity: partitions.map((item) => item.compatibleEdgeDensity),
    stopCount: pairs.map((item) => item.stopCount),
    rawCoordinateCount: pairs.map((item) => item.rawCoordinateCount),
    normalizedCoordinateCount: pairs.map((item) => item.normalizedCoordinateCount),
    segmentCount: pairs.map((item) => item.segmentCount),
    peakFrontierWidth: pairs.map((item) => item.peakFrontierWidth),
    retainedNodeCount: pairs.map((item) => item.retainedNodeCount),
    pairLatencyMs: pairs.map((item) => item.pairTimeMs),
    partitionLatencyMs: partitions.map((item) => item.partitionWallTimeMs),
    assignmentLatencyMs: partitions.map((item) => item.bestAssignmentTimeMs),
    ambiguityProofLatencyMs: partitions.map((item) => item.ambiguityProofTimeMs),
    rssBytes: partitions.map((item) => item.rssBytes),
    heapUsedBytes: partitions.map((item) => item.heapUsedBytes),
  }
  return Object.fromEntries(Object.entries(fields).map(([key, values]) => [key, distribution(values)]))
}

export function buildOutliers(partitions, pairs, topN) {
  return {
    largestPatternPartitions: top(partitions, 'patternCount', topN),
    largestShapePartitions: top(partitions, 'shapeCount', topN),
    largestMinSidePartitions: top(partitions, 'minSideCount', topN),
    densestCompatibleMatrices: top(partitions, 'compatibleEdgeDensity', topN),
    mostStopsPairs: top(pairs, 'stopCount', topN),
    mostSegmentsPairs: top(pairs, 'segmentCount', topN),
    widestFrontierPairs: top(pairs, 'peakFrontierWidth', topN),
    mostRetainedNodesPairs: top(pairs, 'retainedNodeCount', topN),
    slowestPairScoring: top(pairs, 'pairTimeMs', topN),
    slowestAssignmentProofs: top(partitions, 'ambiguityProofTimeMs', topN),
    slowestPartitions: top(partitions, 'partitionWallTimeMs', topN),
    highestRssPartitions: top(partitions, 'rssBytes', topN),
    highestHeapPartitions: top(partitions, 'heapUsedBytes', topN),
    direction2MostSiblings: top(partitions.filter((item) => item.direction === 2), 'shapeCount', topN),
    mixedClosedDirection2Partitions: partitions.filter((partition) => partition.direction === 2
      && (partition.direction2ClosureCounts?.['truly-closed'] ?? 0) > 0
      && (partition.direction2ClosureCounts?.['near-closed'] ?? 0) > 0).slice(0, topN),
  }
}

export function createOutcomeCounts() {
  return {
    exactIdentity: 0,
    geometry: 0,
    invalidPattern: 0,
    noCompatibleShape: 0,
    compatibleShapeAssigned: 0,
    assignmentAmbiguous: 0,
    toleranceEquivalentAlternatives: 0,
    contradictoryCompleteIdentity: 0,
    nearClosedGeometryDisabled: 0,
    rejectedOrInvalidShapes: 0,
    rejectedShapeReasons: {},
  }
}

export function createDirection2Counts() {
  return {
    trulyClosed: 0,
    nearClosed: 0,
    openOrInvalid: 0,
    identitySuccess: 0,
    geometrySuccess: 0,
    geometryOnlySiblingPartitionCount: 0,
    failClosedUnresolved: 0,
    rejectedCount: 0,
  }
}

export function accumulateOutcomes(target, result) {
  target.exactIdentity += result.matches.filter((entry) => entry.basis === 'exact-identity').length
  target.geometry += result.matches.filter((entry) => entry.basis === 'geometry').length
  const mapping = {
    'invalid-pattern': 'invalidPattern',
    'no-compatible-shape': 'noCompatibleShape',
    'compatible-shape-assigned': 'compatibleShapeAssigned',
    'assignment-ambiguous': 'assignmentAmbiguous',
    'tolerance-equivalent-alternatives': 'toleranceEquivalentAlternatives',
    'contradictory-complete-identity': 'contradictoryCompleteIdentity',
    'near-closed-geometry-disabled': 'nearClosedGeometryDisabled',
    'rejected-or-invalid-shapes': 'rejectedOrInvalidShapes',
  }
  for (const entry of result.unresolved) target[mapping[entry.reason]] += 1
  for (const entry of result.rejectedShapes) {
    target.rejectedShapeReasons[entry.reason] = (target.rejectedShapeReasons[entry.reason] ?? 0) + 1
  }
}

export function accumulateDirection2(target, partition, result) {
  if (partition.direction !== 2) return
  const classifications = partition.shapes.map((shape) =>
    classifyClosure(2, normalizeCoordinates(shape.coordinates)).classification)
  target.trulyClosed += classifications.filter((entry) => entry === 'truly-closed').length
  target.nearClosed += classifications.filter((entry) => entry === 'near-closed').length
  target.openOrInvalid += classifications.filter((entry) => entry === 'open-or-invalid').length
  target.identitySuccess += result.matches.filter((entry) => entry.basis === 'exact-identity').length
  target.geometrySuccess += result.matches.filter((entry) => entry.basis === 'geometry').length
  const hasCompleteIdentity = partition.patterns.some((entry) => entry.subRouteUid)
    && partition.shapes.some((entry) => entry.subRouteUid)
  if (!hasCompleteIdentity && partition.shapes.length > 1
    && result.matches.some((entry) => entry.basis === 'geometry')) {
    target.geometryOnlySiblingPartitionCount += 1
  }
  target.failClosedUnresolved += result.unresolved.length
  target.rejectedCount += result.rejectedShapes.length
}

export function maxRawUpdateTime(rawManifest) {
  return (rawManifest.endpoints ?? []).map((entry) => entry.maxUpdateTime).filter(Boolean).sort().at(-1) ?? null
}

export function maxCandidateUpdateTime(candidateBundle) {
  const values = candidateBundle.partitions.flatMap((partition) => partition.shapes
    .map((shape) => shape.measurement?.updateTime).filter(Boolean)).sort()
  return values.at(-1) ?? null
}

export function countBy(records, selector) {
  const result = {}
  for (const record of records) {
    const key = selector(record)
    result[key] = (result[key] ?? 0) + 1
  }
  return result
}

export function median(values) {
  return distribution(values).median ?? 0
}

function top(records, field, count) {
  return records.slice().sort((a, b) => (b[field] ?? -Infinity) - (a[field] ?? -Infinity)
    || stableStringify(a).localeCompare(stableStringify(b))).slice(0, count)
}
