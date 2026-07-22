export type ShapePatternDirection = 0 | 1 | 2
export type ShapePatternCoordinate = readonly [longitude: number, latitude: number]

type ShapePosition = [number, number]

export type ShapePatternStop = {
  stopUid?: string
  coordinate: ShapePatternCoordinate
}

export type ShapePatternCandidate = {
  patternId: string
  routeUid: string
  subRouteUid?: string | null
  direction: ShapePatternDirection
  stops: readonly ShapePatternStop[]
}

export type RouteShapeCandidate = {
  shapeId: string
  routeUid: string
  subRouteUid?: string | null
  direction: ShapePatternDirection
  coordinates: readonly ShapePatternCoordinate[]
}

export type ShapePatternProjection = {
  point: ShapePatternCoordinate
  distanceMeters: number
  segmentIndex: number
  segmentFraction: number
  progressMeters: number
}

export type ShapePatternGeometryMetrics = {
  meanStopDistanceMeters: number
  maxStopDistanceMeters: number
  endpointDistanceMeters: number | null
  matchedSpanMeters: number
  shapeLengthMeters: number
  matchedSpanRatio: number
  coverageDeficitMeters: number | null
}

export type ShapePatternMatch = {
  patternId: string
  shapeId: string
  basis: 'exact-identity' | 'geometry'
  costMeters: number | null
  metrics: ShapePatternGeometryMetrics | null
}

export type UnresolvedShapePatternReason =
  | 'invalid-pattern'
  | 'no-compatible-shape'
  | 'compatible-shape-assigned'
  | 'assignment-ambiguous'
  | 'tolerance-equivalent-alternatives'
  | 'rejected-or-invalid-shapes'
  | 'contradictory-complete-identity'

export type UnresolvedShapePattern = {
  patternId: string
  reason: UnresolvedShapePatternReason
  candidateShapeIds: string[]
}

export type RejectedRouteShape = {
  shapeId: string
  reason: 'duplicate-shape-id' | 'invalid-coordinates' | 'direction-2-not-closed'
}

export type ShapePatternMatchResult = {
  matches: ShapePatternMatch[]
  unresolved: UnresolvedShapePattern[]
  rejectedShapes: RejectedRouteShape[]
  unusedShapeIds: string[]
}

export type ShapePatternMatcherOptions = {
  /** Applied to the total cost of a maximum-cardinality assignment, not to individual pairs. */
  ambiguityAbsoluteMeters?: number
  /** Applied to the total cost of a maximum-cardinality assignment, not to individual pairs. */
  ambiguityRelativeRatio?: number
  maxMeanStopDistanceMeters?: number
  maxStopDistanceMeters?: number
  maxEndpointDistanceMeters?: number
  circularShapeMaxGapMeters?: number
}

type ResolvedOptions = Required<ShapePatternMatcherOptions>

type ValidPattern = ShapePatternCandidate & {
  normalizedSubRouteUid: string | null
  normalizedStops: ShapePatternStop[]
}

type ValidShape = RouteShapeCandidate & {
  normalizedSubRouteUid: string | null
  normalizedCoordinates: ShapePosition[]
}

type RejectedShapeContext = {
  routeUid: string
  direction: ShapePatternDirection
  normalizedSubRouteUid: string | null
}

type ScoredPair = {
  pattern: ValidPattern
  shape: ValidShape
  costMeters: number
  metrics: ShapePatternGeometryMetrics
}

type AssignmentObjective = {
  cardinality: number
  costMeters: number
}

type ProjectionPath = {
  projections: ShapePatternProjection[]
  distanceSumMeters: number
}

type ProjectionState = {
  distanceSumMeters: number
  firstProgressMeters: number
}

type PolylineSegment = {
  index: number
  start: ShapePosition
  end: ShapePosition
  lengthMeters: number
  startProgressMeters: number
}

const DEFAULT_OPTIONS: ResolvedOptions = {
  ambiguityAbsoluteMeters: 1,
  ambiguityRelativeRatio: 0.005,
  maxMeanStopDistanceMeters: 250,
  maxStopDistanceMeters: 1_000,
  maxEndpointDistanceMeters: 1_500,
  circularShapeMaxGapMeters: 500,
}

const FLOATING_COST_EPSILON_FACTOR = 64

/**
 * Match route patterns to Shapes inside RouteUID + Direction partitions.
 * Unique complete identities are committed first. Remaining geometry uses a cached
 * compatibility/cost matrix and an exact maximum-cardinality, minimum-total-cost assignment.
 */
export function matchShapesToPatterns(
  patterns: readonly ShapePatternCandidate[],
  shapes: readonly RouteShapeCandidate[],
  matcherOptions: ShapePatternMatcherOptions = {},
): ShapePatternMatchResult {
  const options = { ...DEFAULT_OPTIONS, ...matcherOptions }
  const duplicatePatternIds = duplicateIds(patterns.map((pattern) => pattern.patternId))
  const duplicateShapeIds = duplicateIds(shapes.map((shape) => shape.shapeId))
  const unresolved: UnresolvedShapePattern[] = []
  const rejectedShapes: RejectedRouteShape[] = []
  const rejectedContexts: RejectedShapeContext[] = []
  const validPatterns: ValidPattern[] = []
  const validShapes: ValidShape[] = []

  for (const pattern of [...patterns].sort(comparePattern)) {
    const normalizedStops = normalizeStops(pattern.stops)
    if (
      duplicatePatternIds.has(pattern.patternId)
      || !pattern.patternId
      || !pattern.routeUid
      || normalizedStops === null
    ) {
      unresolved.push({
        patternId: pattern.patternId,
        reason: 'invalid-pattern',
        candidateShapeIds: [],
      })
      continue
    }
    validPatterns.push({
      ...pattern,
      normalizedSubRouteUid: normalizeIdentity(pattern.subRouteUid),
      normalizedStops,
    })
  }

  const reportedDuplicateShapeIds = new Set<string>()
  for (const shape of [...shapes].sort(compareShape)) {
    const context: RejectedShapeContext = {
      routeUid: shape.routeUid,
      direction: shape.direction,
      normalizedSubRouteUid: normalizeIdentity(shape.subRouteUid),
    }
    if (duplicateShapeIds.has(shape.shapeId)) {
      rejectedContexts.push(context)
      if (!reportedDuplicateShapeIds.has(shape.shapeId)) {
        reportedDuplicateShapeIds.add(shape.shapeId)
        rejectedShapes.push({ shapeId: shape.shapeId, reason: 'duplicate-shape-id' })
      }
      continue
    }
    const normalizedCoordinates = normalizeShapeCoordinates(shape.coordinates)
    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {
      rejectedContexts.push(context)
      rejectedShapes.push({ shapeId: shape.shapeId, reason: 'invalid-coordinates' })
      continue
    }
    if (
      shape.direction === 2
      && !isCircularShape(normalizedCoordinates, options.circularShapeMaxGapMeters)
    ) {
      rejectedContexts.push(context)
      rejectedShapes.push({ shapeId: shape.shapeId, reason: 'direction-2-not-closed' })
      continue
    }
    validShapes.push({
      ...shape,
      normalizedSubRouteUid: normalizeIdentity(shape.subRouteUid),
      normalizedCoordinates,
    })
  }

  const matches: ShapePatternMatch[] = []
  const matchedPatternIds = new Set<string>()
  const matchedShapeIds = new Set<string>()
  matchUniqueExactIdentities(
    validPatterns,
    validShapes,
    matches,
    matchedPatternIds,
    matchedShapeIds,
  )

  const remainingPatterns = validPatterns.filter((pattern) => !matchedPatternIds.has(pattern.patternId))
  const remainingShapes = validShapes.filter((shape) => !matchedShapeIds.has(shape.shapeId))
  const patternsByPartition = groupBy(remainingPatterns, partitionKey)
  const shapesByPartition = groupBy(remainingShapes, partitionKey)

  for (const key of [...patternsByPartition.keys()].sort()) {
    const partitionPatterns = patternsByPartition.get(key) ?? []
    const partitionShapes = shapesByPartition.get(key) ?? []
    const pairs = scorePairs(partitionPatterns, partitionShapes, options)
    const pairsByPattern = groupBy(pairs, (pair) => pair.pattern.patternId)
    const assignablePatterns = partitionPatterns.filter((pattern) => (pairsByPattern.get(pattern.patternId) ?? []).length)

    for (const pattern of partitionPatterns) {
      if ((pairsByPattern.get(pattern.patternId) ?? []).length) continue
      unresolved.push({
        patternId: pattern.patternId,
        reason: noCandidateReason(pattern, partitionShapes, rejectedContexts),
        candidateShapeIds: [],
      })
    }

    if (!assignablePatterns.length || !partitionShapes.length) continue
    const assignment = resolvePartitionAssignment(assignablePatterns, partitionShapes, pairs, options)
    for (const match of assignment.matches) {
      matches.push(match)
      matchedPatternIds.add(match.patternId)
      matchedShapeIds.add(match.shapeId)
    }
    unresolved.push(...assignment.unresolved)
  }

  return {
    matches: matches.sort((a, b) => a.patternId.localeCompare(b.patternId)),
    unresolved: unresolved.sort(compareUnresolved),
    rejectedShapes: rejectedShapes.sort(compareRejectedShape),
    unusedShapeIds: validShapes
      .filter((shape) => !matchedShapeIds.has(shape.shapeId))
      .map((shape) => shape.shapeId)
      .sort(),
  }
}

function resolvePartitionAssignment(
  patterns: ValidPattern[],
  shapes: ValidShape[],
  pairs: ScoredPair[],
  options: ResolvedOptions,
): { matches: ShapePatternMatch[]; unresolved: UnresolvedShapePattern[] } {
  const orderedPatterns = [...patterns].sort(comparePattern)
  const orderedShapes = [...shapes].sort(compareShape)
  const pairByKey = new Map(pairs.map((pair) => [pairKey(pair.pattern.patternId, pair.shape.shapeId), pair]))
  const matrix = orderedPatterns.map((pattern) => orderedShapes.map((shape) =>
    pairByKey.get(pairKey(pattern.patternId, shape.shapeId))?.costMeters ?? null))
  const best = solveAssignmentObjective(matrix)
  const toleranceMeters = assignmentToleranceMeters(best.costMeters, options)
  const acceptedMaxCost = best.costMeters + toleranceMeters
  const exactMaxCost = best.costMeters + floatingCostEpsilon(best.costMeters)
  const matches: ShapePatternMatch[] = []
  const unresolved: UnresolvedShapePattern[] = []

  for (let patternIndex = 0; patternIndex < orderedPatterns.length; patternIndex += 1) {
    const pattern = orderedPatterns[patternIndex]
    const candidateShapeIndices = orderedShapes
      .map((_shape, shapeIndex) => shapeIndex)
      .filter((shapeIndex) => matrix[patternIndex][shapeIndex] !== null)
    const acceptedMatches: number[] = []
    const exactMatches: number[] = []

    for (const shapeIndex of candidateShapeIndices) {
      const objective = solveWithForcedMatch(matrix, patternIndex, shapeIndex)
      if (objectiveIsAccepted(objective, best.cardinality, acceptedMaxCost)) acceptedMatches.push(shapeIndex)
      if (objectiveIsAccepted(objective, best.cardinality, exactMaxCost)) exactMatches.push(shapeIndex)
    }

    const unmatchedObjective = solveWithForcedUnmatched(matrix, patternIndex)
    const acceptedUnmatched = objectiveIsAccepted(unmatchedObjective, best.cardinality, acceptedMaxCost)
    const exactUnmatched = objectiveIsAccepted(unmatchedObjective, best.cardinality, exactMaxCost)

    if (acceptedMatches.length === 1 && !acceptedUnmatched) {
      const shape = orderedShapes[acceptedMatches[0]]
      const pair = pairByKey.get(pairKey(pattern.patternId, shape.shapeId))!
      matches.push({
        patternId: pattern.patternId,
        shapeId: shape.shapeId,
        basis: 'geometry',
        costMeters: roundMetric(pair.costMeters),
        metrics: roundMetrics(pair.metrics),
      })
      continue
    }

    const exactOutcomeCount = exactMatches.length + Number(exactUnmatched)
    let reason: UnresolvedShapePatternReason
    if (!acceptedMatches.length && acceptedUnmatched) {
      reason = 'compatible-shape-assigned'
    } else if (exactOutcomeCount > 1) {
      reason = 'assignment-ambiguous'
    } else {
      reason = 'tolerance-equivalent-alternatives'
    }
    unresolved.push({
      patternId: pattern.patternId,
      reason,
      candidateShapeIds: candidateShapeIndices.map((index) => orderedShapes[index].shapeId).sort(),
    })
  }

  return { matches, unresolved }
}

function solveWithForcedMatch(
  matrix: Array<Array<number | null>>,
  patternIndex: number,
  shapeIndex: number,
): AssignmentObjective {
  const forcedCost = matrix[patternIndex]?.[shapeIndex]
  if (forcedCost === null || forcedCost === undefined) {
    return { cardinality: Number.NEGATIVE_INFINITY, costMeters: Number.POSITIVE_INFINITY }
  }
  const reduced = matrix
    .filter((_row, index) => index !== patternIndex)
    .map((row) => row.filter((_cost, index) => index !== shapeIndex))
  const remainder = solveAssignmentObjective(reduced)
  return {
    cardinality: remainder.cardinality + 1,
    costMeters: remainder.costMeters + forcedCost,
  }
}

function solveWithForcedUnmatched(
  matrix: Array<Array<number | null>>,
  patternIndex: number,
): AssignmentObjective {
  return solveAssignmentObjective(matrix.filter((_row, index) => index !== patternIndex))
}

/** Exact bitmask DP. The bitmask is applied to the smaller side of the bipartite partition. */
function solveAssignmentObjective(matrix: Array<Array<number | null>>): AssignmentObjective {
  const patternCount = matrix.length
  const shapeCount = matrix[0]?.length ?? 0
  if (!patternCount || !shapeCount) return { cardinality: 0, costMeters: 0 }

  const rows = shapeCount <= patternCount
    ? matrix
    : Array.from({ length: shapeCount }, (_unused, shapeIndex) =>
      Array.from({ length: patternCount }, (_unusedPattern, patternIndex) => matrix[patternIndex][shapeIndex]))
  const bitCount = rows[0].length
  let states = new Map<bigint, number>([[0n, 0]])

  for (const row of rows) {
    const next = new Map(states)
    for (const [mask, currentCost] of states) {
      for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
        const pairCost = row[bitIndex]
        const bit = 1n << BigInt(bitIndex)
        if (pairCost === null || (mask & bit) !== 0n) continue
        const nextMask = mask | bit
        const nextCost = currentCost + pairCost
        const known = next.get(nextMask)
        if (known === undefined || nextCost < known) next.set(nextMask, nextCost)
      }
    }
    states = next
  }

  let cardinality = 0
  let costMeters = 0
  for (const [mask, cost] of states) {
    const count = popcount(mask)
    if (count > cardinality || (count === cardinality && cost < costMeters)) {
      cardinality = count
      costMeters = cost
    }
  }
  return { cardinality, costMeters }
}

function scorePairs(
  patterns: ValidPattern[],
  shapes: ValidShape[],
  options: ResolvedOptions,
): ScoredPair[] {
  const pairs: ScoredPair[] = []
  for (const pattern of patterns) {
    for (const shape of shapes) {
      if (!identitiesAreCompatible(pattern, shape)) continue
      const geometry = scoreGeometry(pattern, shape, options)
      if (!geometry) continue
      pairs.push({ pattern, shape, ...geometry })
    }
  }
  return pairs.sort(compareScoredPair)
}

function scoreGeometry(
  pattern: ValidPattern,
  shape: ValidShape,
  options: ResolvedOptions,
): Pick<ScoredPair, 'costMeters' | 'metrics'> | null {
  const forward = scoreOrientation(pattern, shape.normalizedCoordinates, options)
  const reverse = scoreOrientation(pattern, [...shape.normalizedCoordinates].reverse(), options)
  if (!forward) return reverse
  if (!reverse) return forward
  return compareGeometryScore(forward, reverse) <= 0 ? forward : reverse
}

function scoreOrientation(
  pattern: ValidPattern,
  orientedCoordinates: ShapePosition[],
  options: ResolvedOptions,
): Pick<ScoredPair, 'costMeters' | 'metrics'> | null {
  if (pattern.direction === 2) {
    const closed = closeLoopCoordinates(orientedCoordinates, options.circularShapeMaxGapMeters)
    if (!closed) return null
    const loopLengthMeters = polylineLengthMeters(closed)
    if (!(loopLengthMeters > 0)) return null
    const unwrapped = [...closed, ...closed.slice(1).map(copyPosition)]
    const path = matchOrderedStopsToPolyline(pattern.normalizedStops, unwrapped, loopLengthMeters)
    if (!path) return null
    const firstProgress = path.projections[0].progressMeters
    const lastProgress = path.projections.at(-1)!.progressMeters
    const matchedSpanMeters = lastProgress - firstProgress
    if (matchedSpanMeters < 0 || matchedSpanMeters > loopLengthMeters + floatingCostEpsilon(loopLengthMeters)) {
      return null
    }
    const distances = path.projections.map((projection) => projection.distanceMeters)
    const meanStopDistanceMeters = average(distances)
    const maxStopDistanceMeters = Math.max(...distances)
    if (
      meanStopDistanceMeters > options.maxMeanStopDistanceMeters
      || maxStopDistanceMeters > options.maxStopDistanceMeters
    ) return null
    const coverageDeficitMeters = Math.max(0, loopLengthMeters - matchedSpanMeters)
    return {
      costMeters: meanStopDistanceMeters + maxStopDistanceMeters * 0.25 + coverageDeficitMeters,
      metrics: {
        meanStopDistanceMeters,
        maxStopDistanceMeters,
        endpointDistanceMeters: null,
        matchedSpanMeters,
        shapeLengthMeters: loopLengthMeters,
        matchedSpanRatio: matchedSpanMeters / loopLengthMeters,
        coverageDeficitMeters,
      },
    }
  }

  const path = matchOrderedStopsToPolyline(pattern.normalizedStops, orientedCoordinates)
  if (!path) return null
  const distances = path.projections.map((projection) => projection.distanceMeters)
  const meanStopDistanceMeters = average(distances)
  const maxStopDistanceMeters = Math.max(...distances)
  if (
    meanStopDistanceMeters > options.maxMeanStopDistanceMeters
    || maxStopDistanceMeters > options.maxStopDistanceMeters
  ) return null
  const endpointDistanceMeters = average([
    approximateDistanceMeters(pattern.normalizedStops[0].coordinate, orientedCoordinates[0]),
    approximateDistanceMeters(pattern.normalizedStops.at(-1)!.coordinate, orientedCoordinates.at(-1)!),
  ])
  if (endpointDistanceMeters > options.maxEndpointDistanceMeters) return null
  const shapeLengthMeters = polylineLengthMeters(orientedCoordinates)
  const matchedSpanMeters = path.projections.at(-1)!.progressMeters - path.projections[0].progressMeters
  return {
    costMeters: meanStopDistanceMeters + maxStopDistanceMeters * 0.25,
    metrics: {
      meanStopDistanceMeters,
      maxStopDistanceMeters,
      endpointDistanceMeters,
      matchedSpanMeters,
      shapeLengthMeters,
      matchedSpanRatio: shapeLengthMeters > 0 ? matchedSpanMeters / shapeLengthMeters : 0,
      coverageDeficitMeters: null,
    },
  }
}

/**
 * Project every stop to every segment once, then solve the non-decreasing arclength path
 * with prefix minima. Time is O(stops × segments); path/projection storage is the same order.
 */
function matchOrderedStopsToPolyline(
  stops: ShapePatternStop[],
  coordinates: ShapePosition[],
  maxSpanMeters: number | null = null,
): ProjectionPath | null {
  const segments = buildSegments(coordinates)
  if (!stops.length || !segments.length) return null
  const projections = stops.map((stop) => segments.map((segment) => projectStopToSegment(stop.coordinate, segment)))
  const parentSegments = stops.map(() => new Int32Array(segments.length).fill(-1))
  let previous = projections[0].map((projection): ProjectionState => ({
    distanceSumMeters: projection.distanceMeters,
    firstProgressMeters: projection.progressMeters,
  }))

  for (let stopIndex = 1; stopIndex < stops.length; stopIndex += 1) {
    const current = new Array<ProjectionState | null>(segments.length).fill(null)
    let prefixBestIndex = -1
    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (segmentIndex > 0 && betterProjectionState(
        previous[segmentIndex - 1],
        prefixBestIndex < 0 ? null : previous[prefixBestIndex],
        maxSpanMeters !== null,
      )) {
        prefixBestIndex = segmentIndex - 1
      }
      const currentProjection = projections[stopIndex][segmentIndex]
      let parentIndex = prefixBestIndex
      const sameSegmentState = previous[segmentIndex]
      const previousProjection = projections[stopIndex - 1][segmentIndex]
      if (
        previousProjection.segmentFraction <= currentProjection.segmentFraction
        && betterProjectionState(
          sameSegmentState,
          parentIndex < 0 ? null : previous[parentIndex],
          maxSpanMeters !== null,
        )
      ) {
        parentIndex = segmentIndex
      }
      if (parentIndex < 0) continue
      const parent = previous[parentIndex]
      current[segmentIndex] = {
        distanceSumMeters: parent.distanceSumMeters + currentProjection.distanceMeters,
        firstProgressMeters: parent.firstProgressMeters,
      }
      parentSegments[stopIndex][segmentIndex] = parentIndex
    }
    if (current.every((state) => state === null)) return null
    previous = current.map((state) => state ?? {
      distanceSumMeters: Number.POSITIVE_INFINITY,
      firstProgressMeters: Number.POSITIVE_INFINITY,
    })
  }

  let finalSegment = -1
  for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
    if (!Number.isFinite(previous[segmentIndex].distanceSumMeters)) continue
    const spanMeters = projections.at(-1)![segmentIndex].progressMeters - previous[segmentIndex].firstProgressMeters
    if (maxSpanMeters !== null && spanMeters > maxSpanMeters + floatingCostEpsilon(maxSpanMeters)) continue
    if (finalSegment < 0 || betterFinalProjectionPath(
      previous[segmentIndex],
      projections.at(-1)![segmentIndex],
      previous[finalSegment],
      projections.at(-1)![finalSegment],
    )) finalSegment = segmentIndex
  }
  if (finalSegment < 0) return null

  const selected = new Array<ShapePatternProjection>(stops.length)
  let segmentIndex = finalSegment
  for (let stopIndex = stops.length - 1; stopIndex >= 0; stopIndex -= 1) {
    selected[stopIndex] = projections[stopIndex][segmentIndex]
    if (stopIndex > 0) segmentIndex = parentSegments[stopIndex][segmentIndex]
  }
  return {
    projections: selected,
    distanceSumMeters: previous[finalSegment].distanceSumMeters,
  }
}

function projectStopToSegment(
  stop: ShapePatternCoordinate,
  segment: PolylineSegment,
): ShapePatternProjection {
  const referenceLatitudeRadians = ((segment.start[1] + segment.end[1] + stop[1]) / 3) * Math.PI / 180
  const longitudeScale = Math.cos(referenceLatitudeRadians) * 111_320
  const latitudeScale = 110_574
  const segmentX = (segment.end[0] - segment.start[0]) * longitudeScale
  const segmentY = (segment.end[1] - segment.start[1]) * latitudeScale
  const stopX = (stop[0] - segment.start[0]) * longitudeScale
  const stopY = (stop[1] - segment.start[1]) * latitudeScale
  const squaredLength = segmentX * segmentX + segmentY * segmentY
  const segmentFraction = squaredLength > 0
    ? clamp((stopX * segmentX + stopY * segmentY) / squaredLength, 0, 1)
    : 0
  const point: ShapePosition = [
    segment.start[0] + (segment.end[0] - segment.start[0]) * segmentFraction,
    segment.start[1] + (segment.end[1] - segment.start[1]) * segmentFraction,
  ]
  return {
    point,
    distanceMeters: approximateDistanceMeters(stop, point),
    segmentIndex: segment.index,
    segmentFraction,
    progressMeters: segment.startProgressMeters + segment.lengthMeters * segmentFraction,
  }
}

function buildSegments(coordinates: ShapePosition[]): PolylineSegment[] {
  const segments: PolylineSegment[] = []
  let progressMeters = 0
  for (let index = 0; index < coordinates.length - 1; index += 1) {
    const start = coordinates[index]
    const end = coordinates[index + 1]
    const lengthMeters = approximateDistanceMeters(start, end)
    if (!(lengthMeters > 0)) continue
    segments.push({
      index,
      start,
      end,
      lengthMeters,
      startProgressMeters: progressMeters,
    })
    progressMeters += lengthMeters
  }
  return segments
}

function matchUniqueExactIdentities(
  patterns: ValidPattern[],
  shapes: ValidShape[],
  matches: ShapePatternMatch[],
  matchedPatternIds: Set<string>,
  matchedShapeIds: Set<string>,
): void {
  const patternsByIdentity = groupBy(patterns.filter(hasFullPatternIdentity), exactPatternIdentity)
  const shapesByIdentity = groupBy(shapes.filter(hasFullShapeIdentity), exactShapeIdentity)
  for (const identity of [...patternsByIdentity.keys()].sort()) {
    const matchingPatterns = patternsByIdentity.get(identity) ?? []
    const matchingShapes = shapesByIdentity.get(identity) ?? []
    if (matchingPatterns.length !== 1 || matchingShapes.length !== 1) continue
    const pattern = matchingPatterns[0]
    const shape = matchingShapes[0]
    matchedPatternIds.add(pattern.patternId)
    matchedShapeIds.add(shape.shapeId)
    matches.push({
      patternId: pattern.patternId,
      shapeId: shape.shapeId,
      basis: 'exact-identity',
      costMeters: null,
      metrics: null,
    })
  }
}

function noCandidateReason(
  pattern: ValidPattern,
  partitionShapes: ValidShape[],
  rejectedContexts: RejectedShapeContext[],
): UnresolvedShapePatternReason {
  const hasIdentityCompatibleRejectedShape = rejectedContexts.some((shape) =>
    shape.routeUid === pattern.routeUid
    && shape.direction === pattern.direction
    && normalizedIdentitiesAreCompatible(pattern.normalizedSubRouteUid, shape.normalizedSubRouteUid))
  const hasContradictoryCompleteIdentity = pattern.normalizedSubRouteUid !== null
    && partitionShapes.some((shape) =>
      shape.normalizedSubRouteUid !== null
      && shape.normalizedSubRouteUid !== pattern.normalizedSubRouteUid)
    && !partitionShapes.some((shape) => identitiesAreCompatible(pattern, shape))
  if (hasContradictoryCompleteIdentity) return 'contradictory-complete-identity'
  if (hasIdentityCompatibleRejectedShape) return 'rejected-or-invalid-shapes'
  return 'no-compatible-shape'
}

function identitiesAreCompatible(pattern: ValidPattern, shape: ValidShape): boolean {
  return pattern.routeUid === shape.routeUid
    && pattern.direction === shape.direction
    && normalizedIdentitiesAreCompatible(pattern.normalizedSubRouteUid, shape.normalizedSubRouteUid)
}

function normalizedIdentitiesAreCompatible(patternIdentity: string | null, shapeIdentity: string | null): boolean {
  return !(patternIdentity && shapeIdentity && patternIdentity !== shapeIdentity)
}

function closeLoopCoordinates(shape: ShapePosition[], maxGapMeters: number): ShapePosition[] | null {
  if (!isCircularShape(shape, maxGapMeters)) return null
  const copied = shape.map(copyPosition)
  if (!coordinatesEqual(copied[0], copied.at(-1)!)) copied.push(copyPosition(copied[0]))
  return copied
}

function isCircularShape(shape: ShapePosition[], maxGapMeters: number): boolean {
  return shape.length >= 4
    && approximateDistanceMeters(shape[0], shape.at(-1)!) <= maxGapMeters
}

function normalizeStops(stops: readonly ShapePatternStop[]): ShapePatternStop[] | null {
  if (stops.length < 2 || stops.some((stop) => !isValidCoordinate(stop.coordinate))) return null
  return stops.map((stop) => ({ ...stop, coordinate: [...stop.coordinate] as ShapePatternCoordinate }))
}

function normalizeShapeCoordinates(
  coordinates: readonly ShapePatternCoordinate[],
): ShapePosition[] | null {
  if (coordinates.some((coordinate) => !isValidCoordinate(coordinate))) return null
  const normalized: ShapePosition[] = []
  for (const coordinate of coordinates) {
    const mutable: ShapePosition = [coordinate[0], coordinate[1]]
    if (!normalized.length || !coordinatesEqual(normalized.at(-1)!, mutable)) normalized.push(mutable)
  }
  return normalized.length >= 2 ? normalized : null
}

function isValidCoordinate(coordinate: ShapePatternCoordinate): boolean {
  if (!Array.isArray(coordinate) || coordinate.length !== 2) return false
  const [longitude, latitude] = coordinate
  return Number.isFinite(longitude)
    && Number.isFinite(latitude)
    && longitude >= -180
    && longitude <= 180
    && latitude >= -90
    && latitude <= 90
}

function compareGeometryScore(
  a: Pick<ScoredPair, 'costMeters' | 'metrics'>,
  b: Pick<ScoredPair, 'costMeters' | 'metrics'>,
): number {
  return a.costMeters - b.costMeters
    || nullableMetric(a.metrics.endpointDistanceMeters) - nullableMetric(b.metrics.endpointDistanceMeters)
    || b.metrics.matchedSpanMeters - a.metrics.matchedSpanMeters
    || a.metrics.meanStopDistanceMeters - b.metrics.meanStopDistanceMeters
    || a.metrics.maxStopDistanceMeters - b.metrics.maxStopDistanceMeters
}

function betterProjectionState(
  candidate: ProjectionState,
  current: ProjectionState | null,
  preferLaterStart: boolean,
): boolean {
  if (!current) return Number.isFinite(candidate.distanceSumMeters)
  return candidate.distanceSumMeters < current.distanceSumMeters
    || (candidate.distanceSumMeters === current.distanceSumMeters
      && (preferLaterStart
        ? candidate.firstProgressMeters > current.firstProgressMeters
        : candidate.firstProgressMeters < current.firstProgressMeters))
}

function betterFinalProjectionPath(
  candidateState: ProjectionState,
  candidateProjection: ShapePatternProjection,
  currentState: ProjectionState,
  currentProjection: ShapePatternProjection,
): boolean {
  if (candidateState.distanceSumMeters !== currentState.distanceSumMeters) {
    return candidateState.distanceSumMeters < currentState.distanceSumMeters
  }
  const candidateSpan = candidateProjection.progressMeters - candidateState.firstProgressMeters
  const currentSpan = currentProjection.progressMeters - currentState.firstProgressMeters
  return candidateSpan > currentSpan
    || (candidateSpan === currentSpan && candidateProjection.progressMeters < currentProjection.progressMeters)
}

function objectiveIsAccepted(
  objective: AssignmentObjective,
  requiredCardinality: number,
  maxCostMeters: number,
): boolean {
  return objective.cardinality === requiredCardinality
    && objective.costMeters <= maxCostMeters + floatingCostEpsilon(maxCostMeters)
}

function assignmentToleranceMeters(bestCostMeters: number, options: ResolvedOptions): number {
  return Math.max(
    options.ambiguityAbsoluteMeters,
    Math.abs(bestCostMeters) * options.ambiguityRelativeRatio,
  )
}

function floatingCostEpsilon(value: number): number {
  return Number.EPSILON * FLOATING_COST_EPSILON_FACTOR * Math.max(1, Math.abs(value))
}

function popcount(value: bigint): number {
  let count = 0
  let remaining = value
  while (remaining) {
    remaining &= remaining - 1n
    count += 1
  }
  return count
}

function hasFullPatternIdentity(pattern: ValidPattern): boolean {
  return pattern.normalizedSubRouteUid !== null
}

function hasFullShapeIdentity(shape: ValidShape): boolean {
  return shape.normalizedSubRouteUid !== null
}

function exactPatternIdentity(pattern: ValidPattern): string {
  return `${partitionKey(pattern)}:${pattern.normalizedSubRouteUid}`
}

function exactShapeIdentity(shape: ValidShape): string {
  return `${partitionKey(shape)}:${shape.normalizedSubRouteUid}`
}

function partitionKey(value: { routeUid: string; direction: ShapePatternDirection }): string {
  return `${value.routeUid}:${value.direction}`
}

function pairKey(patternId: string, shapeId: string): string {
  return `${patternId}\u0000${shapeId}`
}

function normalizeIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim()
  return normalized ? normalized : null
}

function duplicateIds(ids: string[]): Set<string> {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return duplicates
}

function groupBy<T, K>(items: readonly T[], keyOf: (item: T) => K): Map<K, T[]> {
  const grouped = new Map<K, T[]>()
  for (const item of items) {
    const key = keyOf(item)
    const values = grouped.get(key) ?? []
    values.push(item)
    grouped.set(key, values)
  }
  return grouped
}

function polylineLengthMeters(coordinates: ShapePosition[]): number {
  let length = 0
  for (let index = 1; index < coordinates.length; index += 1) {
    length += approximateDistanceMeters(coordinates[index - 1], coordinates[index])
  }
  return length
}

function approximateDistanceMeters(a: ShapePatternCoordinate, b: ShapePatternCoordinate): number {
  const latitude = (a[1] + b[1]) * Math.PI / 360
  const longitudeMeters = (a[0] - b[0]) * Math.cos(latitude) * 111_320
  const latitudeMeters = (a[1] - b[1]) * 110_574
  return Math.hypot(longitudeMeters, latitudeMeters)
}

function average(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length
}

function nullableMetric(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY
}

function coordinatesEqual(a: ShapePatternCoordinate, b: ShapePatternCoordinate): boolean {
  return a[0] === b[0] && a[1] === b[1]
}

function copyPosition(position: ShapePatternCoordinate): ShapePosition {
  return [position[0], position[1]]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000
}

function roundMetrics(metrics: ShapePatternGeometryMetrics): ShapePatternGeometryMetrics {
  return {
    meanStopDistanceMeters: roundMetric(metrics.meanStopDistanceMeters),
    maxStopDistanceMeters: roundMetric(metrics.maxStopDistanceMeters),
    endpointDistanceMeters: metrics.endpointDistanceMeters === null
      ? null
      : roundMetric(metrics.endpointDistanceMeters),
    matchedSpanMeters: roundMetric(metrics.matchedSpanMeters),
    shapeLengthMeters: roundMetric(metrics.shapeLengthMeters),
    matchedSpanRatio: Math.round(metrics.matchedSpanRatio * 1_000_000) / 1_000_000,
    coverageDeficitMeters: metrics.coverageDeficitMeters === null
      ? null
      : roundMetric(metrics.coverageDeficitMeters),
  }
}

function comparePattern(a: ShapePatternCandidate, b: ShapePatternCandidate): number {
  return a.patternId.localeCompare(b.patternId)
}

function compareShape(a: RouteShapeCandidate, b: RouteShapeCandidate): number {
  return a.shapeId.localeCompare(b.shapeId)
}

function compareScoredPair(a: ScoredPair, b: ScoredPair): number {
  return a.pattern.patternId.localeCompare(b.pattern.patternId)
    || a.shape.shapeId.localeCompare(b.shape.shapeId)
}

function compareUnresolved(a: UnresolvedShapePattern, b: UnresolvedShapePattern): number {
  return a.patternId.localeCompare(b.patternId)
    || a.reason.localeCompare(b.reason)
}

function compareRejectedShape(a: RejectedRouteShape, b: RejectedRouteShape): number {
  return a.shapeId.localeCompare(b.shapeId)
    || a.reason.localeCompare(b.reason)
}
