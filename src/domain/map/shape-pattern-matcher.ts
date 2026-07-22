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

type ShapePatternProjection = {
  point: ShapePatternCoordinate
  distanceMeters: number
  segmentIndex: number
  segmentFraction: number
  progressMeters: number
}

/**
 * Diagnostic geometry only. These values are not a confidence score and are not a
 * stable ranking contract for adapters. In particular, Direction 2 coverage fields
 * are reported for later calibration but do not contribute to pair cost.
 */
export type ShapePatternGeometryMetrics = {
  meanStopDistanceMeters: number
  maxStopDistanceMeters: number
  endpointDistanceMeters: number | null
  matchedSpanMeters: number
  shapeLengthMeters: number
  matchedSpanRatio: number
  coverageDeficitMeters: number | null
  /** Original normalized endpoint gap; separate from actual polyline length. */
  closureGapDistanceMeters: number | null
}

export type ShapePatternMatch = {
  patternId: string
  shapeId: string
  basis: 'exact-identity' | 'geometry'
  costMeters: number | null
  /** Diagnostic-only geometry; not a confidence or ranking API contract. */
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
  | 'near-closed-geometry-disabled'

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
  /** Absolute floor for assignment-outcome ambiguity. Exact boundary is inclusive. */
  ambiguityAbsoluteMeters?: number
  /** Relative tolerance applied only to the best assignment's changed sub-assignment. */
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

type Direction2ClosureKind = 'truly-closed' | 'near-closed'

type ValidShape = RouteShapeCandidate & {
  normalizedSubRouteUid: string | null
  normalizedCoordinates: ShapePosition[]
  direction2ClosureKind: Direction2ClosureKind | null
  closureGapDistanceMeters: number | null
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

type AssignmentEdge = {
  patternIndex: number
  shapeIndex: number
  costMeters: number
}

type AssignmentSolution = {
  cardinality: number
  costMeters: number
  edges: AssignmentEdge[]
  key: string
}

type AssignmentDpState = {
  costMeters: number
  parent: AssignmentDpState | null
  edge: AssignmentEdge | null
}

type ProjectionObjective = 'cost' | 'span'

type ProjectionPath = {
  projections: ShapePatternProjection[]
  distanceSumMeters: number
  maxDistanceMeters: number
}

type ProjectionNode = {
  projection: ShapePatternProjection
  distanceSumMeters: number
  maxDistanceMeters: number
  firstProgressMeters: number
  parent: ProjectionNode | null
  pathKey: string
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

const NUMERIC_OPTION_NAMES = [
  'ambiguityAbsoluteMeters',
  'ambiguityRelativeRatio',
  'maxMeanStopDistanceMeters',
  'maxStopDistanceMeters',
  'maxEndpointDistanceMeters',
  'circularShapeMaxGapMeters',
] as const satisfies readonly (keyof ResolvedOptions)[]

const FLOATING_COST_EPSILON_FACTOR = 64
const NUMERIC_METERS_EPSILON = 1e-9
const STOP_DISTANCE_MAX_WEIGHT = 0.25

/**
 * Match route patterns to Shapes inside RouteUID + Direction partitions.
 * Every valid geometry pair is scored once before exact identities consume rows or
 * columns. Unique complete identities are then committed, and remaining geometry
 * uses exact maximum-cardinality, minimum-total-cost assignment.
 */
export function matchShapesToPatterns(
  patterns: readonly ShapePatternCandidate[],
  shapes: readonly RouteShapeCandidate[],
  matcherOptions: ShapePatternMatcherOptions = {},
): ShapePatternMatchResult {
  const options: ResolvedOptions = { ...DEFAULT_OPTIONS, ...matcherOptions }
  validateResolvedOptions(options)
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
    let normalizedCoordinates = normalizeShapeCoordinates(shape.coordinates)
    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {
      rejectedContexts.push(context)
      rejectedShapes.push({ shapeId: shape.shapeId, reason: 'invalid-coordinates' })
      continue
    }
    let direction2ClosureKind: Direction2ClosureKind | null = null
    let closureGapDistanceMeters: number | null = null
    if (shape.direction === 2) {
      const closure = classifyDirection2Closure(
        normalizedCoordinates,
        options.circularShapeMaxGapMeters,
      )
      if (closure.kind === 'open') {
        rejectedContexts.push(context)
        rejectedShapes.push({ shapeId: shape.shapeId, reason: 'direction-2-not-closed' })
        continue
      }
      direction2ClosureKind = closure.kind
      closureGapDistanceMeters = closure.gapDistanceMeters
      if (closure.kind === 'truly-closed') {
        normalizedCoordinates = normalizeTrulyClosedEndpoint(normalizedCoordinates)
      }
    }
    validShapes.push({
      ...shape,
      normalizedSubRouteUid: normalizeIdentity(shape.subRouteUid),
      normalizedCoordinates,
      direction2ClosureKind,
      closureGapDistanceMeters,
    })
  }

  // M-1: score the complete original compatibility matrix exactly once, before
  // unique exact identities consume any pattern or Shape.
  const allPairs = scorePairs(validPatterns, validShapes, options)
  const allPairsByPattern = groupBy(allPairs, (pair) => pair.pattern.patternId)
  const allPairsByPartition = groupBy(allPairs, (pair) => partitionKey(pair.pattern))
  const allShapesByPartition = groupBy(validShapes, partitionKey)

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
  const remainingShapesByPartition = groupBy(remainingShapes, partitionKey)

  for (const key of [...patternsByPartition.keys()].sort()) {
    const partitionPatterns = patternsByPartition.get(key) ?? []
    const partitionShapes = remainingShapesByPartition.get(key) ?? []
    const originalPartitionShapes = allShapesByPartition.get(key) ?? []
    const originalPairs = allPairsByPartition.get(key) ?? []
    const remainingPatternIds = new Set(partitionPatterns.map((pattern) => pattern.patternId))
    const remainingShapeIds = new Set(partitionShapes.map((shape) => shape.shapeId))
    const rawAssignmentPairs = originalPairs.filter((pair) =>
      remainingPatternIds.has(pair.pattern.patternId) && remainingShapeIds.has(pair.shape.shapeId))
    const assignmentPairs = rawAssignmentPairs
    const assignmentPairsByPattern = groupBy(assignmentPairs, (pair) => pair.pattern.patternId)
    const assignablePatterns: ValidPattern[] = []

    for (const pattern of partitionPatterns) {
      const originalCandidates = allPairsByPattern.get(pattern.patternId) ?? []
      const rawRemainingCandidates = rawAssignmentPairs.filter((pair) =>
        pair.pattern.patternId === pattern.patternId)
      const remainingCandidates = assignmentPairsByPattern.get(pattern.patternId) ?? []
      if (
        pattern.direction === 2
        && originalCandidates.length > 1
        && rawRemainingCandidates.length
      ) {
        // Without calibrated real-TDX evidence, multiple geometry-only closed-loop
        // candidates are deliberately not ranked. Unique exact identity remains the
        // only direct multi-candidate Direction 2 resolution in this PR.
        unresolved.push({
          patternId: pattern.patternId,
          reason: 'tolerance-equivalent-alternatives',
          candidateShapeIds: candidateShapeIds(originalCandidates),
        })
        continue
      }
      if (remainingCandidates.length) {
        assignablePatterns.push(pattern)
        continue
      }
      if (originalCandidates.length) {
        unresolved.push({
          patternId: pattern.patternId,
          reason: 'compatible-shape-assigned',
          candidateShapeIds: candidateShapeIds(originalCandidates),
        })
        continue
      }
      const reason = noCandidateReason(pattern, originalPartitionShapes, rejectedContexts)
      unresolved.push({
        patternId: pattern.patternId,
        reason,
        candidateShapeIds: reason === 'near-closed-geometry-disabled'
          ? nearClosedCandidateShapeIds(pattern, originalPartitionShapes)
          : [],
      })
    }

    if (!assignablePatterns.length || !partitionShapes.length) continue
    const assignment = resolvePartitionAssignment(
      assignablePatterns,
      partitionShapes,
      assignmentPairs,
      allPairsByPattern,
      options,
    )
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

function validateResolvedOptions(options: ResolvedOptions): void {
  for (const optionName of NUMERIC_OPTION_NAMES) {
    const value = options[optionName]
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(
        `ShapePatternMatcher option "${optionName}" must be a finite non-negative number.`,
      )
    }
  }
}

function resolvePartitionAssignment(
  patterns: ValidPattern[],
  shapes: ValidShape[],
  pairs: ScoredPair[],
  allPairsByPattern: Map<string, ScoredPair[]>,
  options: ResolvedOptions,
): { matches: ShapePatternMatch[]; unresolved: UnresolvedShapePattern[] } {
  const orderedPatterns = [...patterns].sort(comparePattern)
  const orderedShapes = [...shapes].sort(compareShape)
  const pairByKey = new Map(pairs.map((pair) => [pairKey(pair.pattern.patternId, pair.shape.shapeId), pair]))
  const matrix = orderedPatterns.map((pattern) => orderedShapes.map((shape) =>
    pairByKey.get(pairKey(pattern.patternId, shape.shapeId))?.costMeters ?? null))
  const best = solveAssignment(matrix)
  const matches: ShapePatternMatch[] = []
  const unresolved: UnresolvedShapePattern[] = []

  for (let patternIndex = 0; patternIndex < orderedPatterns.length; patternIndex += 1) {
    const pattern = orderedPatterns[patternIndex]
    const originalCandidates = allPairsByPattern.get(pattern.patternId) ?? []
    const originalCandidateIds = candidateShapeIds(originalCandidates)
    const candidateShapeIndices = orderedShapes
      .map((_shape, shapeIndex) => shapeIndex)
      .filter((shapeIndex) => matrix[patternIndex][shapeIndex] !== null)
    const acceptedMatches: number[] = []
    const exactMatches: number[] = []

    for (const shapeIndex of candidateShapeIndices) {
      const solution = solveWithForcedMatch(matrix, patternIndex, shapeIndex)
      if (assignmentsAreToleranceEquivalent(best, solution, options)) acceptedMatches.push(shapeIndex)
      if (assignmentsAreExactlyEquivalent(best, solution)) exactMatches.push(shapeIndex)
    }

    const unmatchedSolution = solveWithForcedUnmatched(matrix, patternIndex)
    const acceptedUnmatched = assignmentsAreToleranceEquivalent(best, unmatchedSolution, options)
    const exactUnmatched = assignmentsAreExactlyEquivalent(best, unmatchedSolution)

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
      candidateShapeIds: originalCandidateIds,
    })
  }

  return { matches, unresolved }
}

function solveWithForcedMatch(
  matrix: Array<Array<number | null>>,
  patternIndex: number,
  shapeIndex: number,
): AssignmentSolution {
  const forcedCost = matrix[patternIndex]?.[shapeIndex]
  if (forcedCost === null || forcedCost === undefined) return impossibleAssignment()
  const remainingPatterns = range(matrix.length).filter((index) => index !== patternIndex)
  const remainingShapes = range(matrix[0]?.length ?? 0).filter((index) => index !== shapeIndex)
  const remainder = solveAssignment(matrix, remainingPatterns, remainingShapes)
  const edges = sortAssignmentEdges([
    ...remainder.edges,
    { patternIndex, shapeIndex, costMeters: forcedCost },
  ])
  return {
    cardinality: remainder.cardinality + 1,
    costMeters: remainder.costMeters + forcedCost,
    edges,
    key: assignmentKey(edges),
  }
}

function solveWithForcedUnmatched(
  matrix: Array<Array<number | null>>,
  patternIndex: number,
): AssignmentSolution {
  return solveAssignment(
    matrix,
    range(matrix.length).filter((index) => index !== patternIndex),
    range(matrix[0]?.length ?? 0),
  )
}

/** Exact bitmask DP. The bitmask is applied to the smaller side of the partition. */
function solveAssignment(
  matrix: Array<Array<number | null>>,
  patternIndices: number[] = range(matrix.length),
  shapeIndices: number[] = range(matrix[0]?.length ?? 0),
): AssignmentSolution {
  if (!patternIndices.length || !shapeIndices.length) return emptyAssignment()

  const transpose = shapeIndices.length > patternIndices.length
  const rowIndices = transpose ? shapeIndices : patternIndices
  const bitIndices = transpose ? patternIndices : shapeIndices
  let states = new Map<bigint, AssignmentDpState>([[0n, {
    costMeters: 0,
    parent: null,
    edge: null,
  }]])

  for (const rowIndex of rowIndices) {
    // Reusing the previous state is the exact "leave this row unmatched" transition.
    const next = new Map(states)
    for (const [mask, state] of states) {
      for (let bitPosition = 0; bitPosition < bitIndices.length; bitPosition += 1) {
        const bit = 1n << BigInt(bitPosition)
        if ((mask & bit) !== 0n) continue
        const bitIndex = bitIndices[bitPosition]
        const patternIndex = transpose ? bitIndex : rowIndex
        const shapeIndex = transpose ? rowIndex : bitIndex
        const pairCost = matrix[patternIndex]?.[shapeIndex]
        if (pairCost === null || pairCost === undefined) continue
        const nextMask = mask | bit
        const nextCost = state.costMeters + pairCost
        const known = next.get(nextMask)
        if (known && compareFloating(known.costMeters, nextCost) <= 0) continue
        next.set(nextMask, {
          costMeters: nextCost,
          parent: state,
          edge: { patternIndex, shapeIndex, costMeters: pairCost },
        })
      }
    }
    states = next
  }

  let best = emptyAssignment()
  for (const [mask, state] of states) {
    const cardinality = popcount(mask)
    if (cardinality < best.cardinality) continue
    if (cardinality === best.cardinality
      && compareFloating(state.costMeters, best.costMeters) > 0) continue
    const edges = reconstructAssignmentEdges(state)
    const candidate: AssignmentSolution = {
      cardinality,
      costMeters: state.costMeters,
      edges,
      key: assignmentKey(edges),
    }
    if (compareAssignmentSolution(candidate, best) < 0) best = candidate
  }
  return best
}

function reconstructAssignmentEdges(state: AssignmentDpState): AssignmentEdge[] {
  const edges: AssignmentEdge[] = []
  let current: AssignmentDpState | null = state
  while (current) {
    if (current.edge) edges.push(current.edge)
    current = current.parent
  }
  return sortAssignmentEdges(edges)
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
      if (shape.direction2ClosureKind === 'near-closed') continue
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
  if (pattern.direction === 2 && shape.direction2ClosureKind !== 'truly-closed') return null
  const forward = scoreOrientation(
    pattern,
    shape.normalizedCoordinates,
    options,
    shape.closureGapDistanceMeters,
  )
  const reverse = scoreOrientation(
    pattern,
    [...shape.normalizedCoordinates].reverse(),
    options,
    shape.closureGapDistanceMeters,
  )
  if (!forward) return reverse
  if (!reverse) return forward
  return compareGeometryScore(forward, reverse) <= 0 ? forward : reverse
}

function scoreOrientation(
  pattern: ValidPattern,
  orientedCoordinates: ShapePosition[],
  options: ResolvedOptions,
  closureGapDistanceMeters: number | null,
): Pick<ScoredPair, 'costMeters' | 'metrics'> | null {
  if (pattern.direction === 2) {
    if (!coordinatesEqual(orientedCoordinates[0], orientedCoordinates.at(-1)!)) return null
    const loopLengthMeters = polylineLengthMeters(orientedCoordinates)
    if (!(loopLengthMeters > 0)) return null
    // The second lap duplicates only upstream segments already present in the
    // normalized truly closed Shape. No system-generated operational segment exists.
    const unwrapped = [
      ...orientedCoordinates,
      ...orientedCoordinates.slice(1).map(copyPosition),
    ]
    const projectionOptions = {
      maxSpanMeters: loopLengthMeters,
      maxMeanStopDistanceMeters: options.maxMeanStopDistanceMeters,
      maxStopDistanceMeters: options.maxStopDistanceMeters,
    }
    const path = matchOrderedStopsToPolyline(pattern.normalizedStops, unwrapped, {
      ...projectionOptions,
      objective: 'cost',
    })
    if (!path) return null
    const diagnosticPath = matchOrderedStopsToPolyline(pattern.normalizedStops, unwrapped, {
      ...projectionOptions,
      objective: 'span',
    }) ?? path
    const firstProgress = diagnosticPath.projections[0].progressMeters
    const lastProgress = diagnosticPath.projections.at(-1)!.progressMeters
    const matchedSpanMeters = lastProgress - firstProgress
    if (matchedSpanMeters < 0 || !atOrBelowFloatingThreshold(matchedSpanMeters, loopLengthMeters)) {
      return null
    }
    const meanStopDistanceMeters = path.distanceSumMeters / path.projections.length
    const maxStopDistanceMeters = path.maxDistanceMeters
    const coverageDeficitMeters = Math.max(0, loopLengthMeters - matchedSpanMeters)
    return {
      // Coverage is intentionally excluded until real TDX distributions calibrate a bounded policy.
      costMeters: stopDistanceObjective(meanStopDistanceMeters, maxStopDistanceMeters),
      metrics: {
        meanStopDistanceMeters,
        maxStopDistanceMeters,
        endpointDistanceMeters: null,
        matchedSpanMeters,
        shapeLengthMeters: loopLengthMeters,
        matchedSpanRatio: matchedSpanMeters / loopLengthMeters,
        coverageDeficitMeters,
        closureGapDistanceMeters,
      },
    }
  }

  const path = matchOrderedStopsToPolyline(pattern.normalizedStops, orientedCoordinates, {
    objective: 'cost',
    maxSpanMeters: null,
    maxMeanStopDistanceMeters: options.maxMeanStopDistanceMeters,
    maxStopDistanceMeters: options.maxStopDistanceMeters,
  })
  if (!path) return null
  const meanStopDistanceMeters = path.distanceSumMeters / path.projections.length
  const maxStopDistanceMeters = path.maxDistanceMeters
  const endpointDistanceMeters = average([
    approximateDistanceMeters(pattern.normalizedStops[0].coordinate, orientedCoordinates[0]),
    approximateDistanceMeters(pattern.normalizedStops.at(-1)!.coordinate, orientedCoordinates.at(-1)!),
  ])
  if (!atOrBelowFloatingThreshold(endpointDistanceMeters, options.maxEndpointDistanceMeters)) return null
  const shapeLengthMeters = polylineLengthMeters(orientedCoordinates)
  const matchedSpanMeters = path.projections.at(-1)!.progressMeters - path.projections[0].progressMeters
  return {
    costMeters: stopDistanceObjective(meanStopDistanceMeters, maxStopDistanceMeters),
    metrics: {
      meanStopDistanceMeters,
      maxStopDistanceMeters,
      endpointDistanceMeters,
      matchedSpanMeters,
      shapeLengthMeters,
      matchedSpanRatio: shapeLengthMeters > 0 ? matchedSpanMeters / shapeLengthMeters : 0,
      coverageDeficitMeters: null,
      closureGapDistanceMeters: null,
    },
  }
}

/**
 * Exact nondominated-frontier projection solver.
 *
 * Each state retains cumulative distance, maximum stop distance, first and current
 * progress, Direction 2 one-lap feasibility, and a complete parent chain. Cost and
 * diagnostic-span objectives share the same exact frontier but are selected separately. A state
 * is discarded only when another state is no worse in every cost component and
 * has an equal-or-better future-feasibility/span relation. No cardinality cap,
 * greedy fallback, or approximate beam pruning is used.
 */
function matchOrderedStopsToPolyline(
  stops: ShapePatternStop[],
  coordinates: ShapePosition[],
  options: {
    objective: ProjectionObjective
    maxSpanMeters: number | null
    maxMeanStopDistanceMeters: number
    maxStopDistanceMeters: number
  },
): ProjectionPath | null {
  const segments = buildSegments(coordinates)
  if (!stops.length || !segments.length) return null
  const projections = stops.map((stop) => segments.map((segment) => projectStopToSegment(stop.coordinate, segment)))
  const spanConstrained = options.maxSpanMeters !== null
  let previous = projections[0].map((projection) => [initialProjectionNode(projection)])

  for (let stopIndex = 1; stopIndex < stops.length; stopIndex += 1) {
    const current: ProjectionNode[][] = Array.from({ length: segments.length }, () => [])
    let prefixParents: ProjectionNode[] = []

    for (let segmentIndex = 0; segmentIndex < segments.length; segmentIndex += 1) {
      if (segmentIndex > 0) {
        prefixParents = pruneProjectionFrontier(
          [...prefixParents, ...previous[segmentIndex - 1]],
          spanConstrained,
        )
      }
      const currentProjection = projections[stopIndex][segmentIndex]
      const sameSegmentParents = previous[segmentIndex].filter((node) =>
        node.projection.segmentFraction
          <= currentProjection.segmentFraction + floatingCostEpsilon(currentProjection.segmentFraction))
      const parents = pruneProjectionFrontier(
        [...prefixParents, ...sameSegmentParents],
        spanConstrained,
      )
      const generated: ProjectionNode[] = []
      for (const parent of parents) {
        const node = extendProjectionNode(parent, currentProjection)
        if (
          options.maxSpanMeters !== null
          && !atOrBelowFloatingThreshold(
            currentProjection.progressMeters - node.firstProgressMeters,
            options.maxSpanMeters,
          )
        ) continue
        generated.push(node)
      }
      current[segmentIndex] = pruneProjectionFrontier(generated, spanConstrained)
    }

    if (current.every((frontier) => frontier.length === 0)) return null
    previous = current
  }

  const finalNodes = previous.flat().filter((node) =>
    atOrBelowFloatingThreshold(node.maxDistanceMeters, options.maxStopDistanceMeters)
    && atOrBelowFloatingThreshold(
      node.distanceSumMeters / stops.length,
      options.maxMeanStopDistanceMeters,
    ))
  if (!finalNodes.length) return null
  finalNodes.sort((a, b) => compareFinalProjectionNode(
    a,
    b,
    stops.length,
    options.objective,
  ))
  const best = finalNodes[0]
  const selected = reconstructProjectionPath(best, stops.length)
  if (!selected) return null
  return {
    projections: selected,
    distanceSumMeters: best.distanceSumMeters,
    maxDistanceMeters: best.maxDistanceMeters,
  }
}

function initialProjectionNode(projection: ShapePatternProjection): ProjectionNode {
  return {
    projection,
    distanceSumMeters: projection.distanceMeters,
    maxDistanceMeters: projection.distanceMeters,
    firstProgressMeters: projection.progressMeters,
    parent: null,
    pathKey: projectionPathPart(projection),
  }
}

function extendProjectionNode(parent: ProjectionNode, projection: ShapePatternProjection): ProjectionNode {
  return {
    projection,
    distanceSumMeters: parent.distanceSumMeters + projection.distanceMeters,
    maxDistanceMeters: Math.max(parent.maxDistanceMeters, projection.distanceMeters),
    firstProgressMeters: parent.firstProgressMeters,
    parent,
    pathKey: `${parent.pathKey}|${projectionPathPart(projection)}`,
  }
}

function pruneProjectionFrontier(
  candidates: ProjectionNode[],
  spanConstrained: boolean,
): ProjectionNode[] {
  if (candidates.length < 2) return candidates
  const ordered = [...candidates].sort((a, b) => compareProjectionNodeCanonical(a, b, spanConstrained))
  const frontier: ProjectionNode[] = []
  for (const candidate of ordered) {
    if (frontier.some((current) => projectionNodeDominates(current, candidate, spanConstrained))) continue
    for (let index = frontier.length - 1; index >= 0; index -= 1) {
      if (projectionNodeDominates(candidate, frontier[index], spanConstrained)) frontier.splice(index, 1)
    }
    frontier.push(candidate)
  }
  return frontier.sort((a, b) => compareProjectionNodeCanonical(a, b, spanConstrained))
}

function projectionNodeDominates(
  candidate: ProjectionNode,
  current: ProjectionNode,
  spanConstrained: boolean,
): boolean {
  const sumComparison = compareFloating(candidate.distanceSumMeters, current.distanceSumMeters)
  const maxComparison = compareFloating(candidate.maxDistanceMeters, current.maxDistanceMeters)
  if (sumComparison > 0 || maxComparison > 0) return false

  if (!spanConstrained) {
    const firstComparison = compareFloating(candidate.firstProgressMeters, current.firstProgressMeters)
    if (firstComparison > 0) return false
    return sumComparison < 0
      || maxComparison < 0
      || firstComparison < 0
      || candidate.pathKey <= current.pathKey
  }

  // Different Direction 2 starts trade diagnostic span against future seam
  // feasibility, so exact pruning cannot compare them solely by accumulated cost.
  const firstComparison = compareFloating(candidate.firstProgressMeters, current.firstProgressMeters)
  if (firstComparison !== 0) return false
  return sumComparison < 0
    || maxComparison < 0
    || candidate.pathKey <= current.pathKey
}

function compareProjectionNodeCanonical(
  a: ProjectionNode,
  b: ProjectionNode,
  spanConstrained: boolean,
): number {
  return compareFloating(a.distanceSumMeters, b.distanceSumMeters)
    || compareFloating(a.maxDistanceMeters, b.maxDistanceMeters)
    || (spanConstrained
      ? compareFloating(b.firstProgressMeters, a.firstProgressMeters)
      : compareFloating(a.firstProgressMeters, b.firstProgressMeters))
    || a.pathKey.localeCompare(b.pathKey)
}

function compareFinalProjectionNode(
  a: ProjectionNode,
  b: ProjectionNode,
  stopCount: number,
  objective: ProjectionObjective,
): number {
  const aMean = a.distanceSumMeters / stopCount
  const bMean = b.distanceSumMeters / stopCount
  const aCost = stopDistanceObjective(aMean, a.maxDistanceMeters)
  const bCost = stopDistanceObjective(bMean, b.maxDistanceMeters)
  const aSpan = a.projection.progressMeters - a.firstProgressMeters
  const bSpan = b.projection.progressMeters - b.firstProgressMeters
  if (objective === 'span') {
    return compareFloating(bSpan, aSpan)
      || compareFloating(aCost, bCost)
      || compareFloating(aMean, bMean)
      || compareFloating(a.maxDistanceMeters, b.maxDistanceMeters)
      || a.pathKey.localeCompare(b.pathKey)
  }
  return compareFloating(aCost, bCost)
    || compareFloating(bSpan, aSpan)
    || compareFloating(aMean, bMean)
    || compareFloating(a.maxDistanceMeters, b.maxDistanceMeters)
    || a.pathKey.localeCompare(b.pathKey)
}

function reconstructProjectionPath(node: ProjectionNode, stopCount: number): ShapePatternProjection[] | null {
  const selected = new Array<ShapePatternProjection>(stopCount)
  let current: ProjectionNode | null = node
  for (let index = stopCount - 1; index >= 0; index -= 1) {
    if (!current) return null
    selected[index] = current.projection
    current = current.parent
  }
  return current === null ? selected : null
}

function projectionPathPart(projection: ShapePatternProjection): string {
  return `${projection.segmentIndex.toString().padStart(8, '0')}:${projection.segmentFraction.toFixed(12)}`
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
  const hasIdentityCompatibleNearClosedShape = partitionShapes.some((shape) =>
    shape.direction2ClosureKind === 'near-closed' && identitiesAreCompatible(pattern, shape))
  if (hasContradictoryCompleteIdentity) return 'contradictory-complete-identity'
  if (hasIdentityCompatibleNearClosedShape) return 'near-closed-geometry-disabled'
  if (hasIdentityCompatibleRejectedShape) return 'rejected-or-invalid-shapes'
  return 'no-compatible-shape'
}

function nearClosedCandidateShapeIds(pattern: ValidPattern, shapes: ValidShape[]): string[] {
  return shapes
    .filter((shape) =>
      shape.direction2ClosureKind === 'near-closed' && identitiesAreCompatible(pattern, shape))
    .map((shape) => shape.shapeId)
    .sort()
}

function identitiesAreCompatible(pattern: ValidPattern, shape: ValidShape): boolean {
  return pattern.routeUid === shape.routeUid
    && pattern.direction === shape.direction
    && normalizedIdentitiesAreCompatible(pattern.normalizedSubRouteUid, shape.normalizedSubRouteUid)
}

function normalizedIdentitiesAreCompatible(patternIdentity: string | null, shapeIdentity: string | null): boolean {
  return !(patternIdentity && shapeIdentity && patternIdentity !== shapeIdentity)
}

function classifyDirection2Closure(
  shape: ShapePosition[],
  maxGapMeters: number,
): { kind: Direction2ClosureKind | 'open'; gapDistanceMeters: number } {
  if (shape.length < 4) return { kind: 'open', gapDistanceMeters: Number.POSITIVE_INFINITY }
  const gapDistanceMeters = approximateDistanceMeters(shape[0], shape.at(-1)!)
  if (coordinatesEqual(shape[0], shape.at(-1)!)
    || atOrBelowFloatingThreshold(gapDistanceMeters, 0)) {
    return { kind: 'truly-closed', gapDistanceMeters }
  }
  if (atOrBelowFloatingThreshold(gapDistanceMeters, maxGapMeters)) {
    return { kind: 'near-closed', gapDistanceMeters }
  }
  return { kind: 'open', gapDistanceMeters }
}

function normalizeTrulyClosedEndpoint(shape: ShapePosition[]): ShapePosition[] {
  const copied = shape.map(copyPosition)
  copied[copied.length - 1] = copyPosition(copied[0])
  return copied
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
  const simplified = removeCollinearCoordinates(normalized)
  return simplified.length >= 2 ? simplified : null
}

/** Remove exact geometric density points without changing the represented polyline. */
function removeCollinearCoordinates(coordinates: ShapePosition[]): ShapePosition[] {
  if (coordinates.length < 3) return coordinates
  const simplified: ShapePosition[] = []
  for (const coordinate of coordinates) {
    simplified.push(coordinate)
    while (simplified.length >= 3) {
      const a = simplified[simplified.length - 3]
      const b = simplified[simplified.length - 2]
      const c = simplified[simplified.length - 1]
      if (!isCoordinateBetweenOnStraightSegment(a, b, c)) break
      simplified.splice(simplified.length - 2, 1)
    }
  }
  return simplified
}

function isCoordinateBetweenOnStraightSegment(
  a: ShapePatternCoordinate,
  b: ShapePatternCoordinate,
  c: ShapePatternCoordinate,
): boolean {
  const abX = b[0] - a[0]
  const abY = b[1] - a[1]
  const acX = c[0] - a[0]
  const acY = c[1] - a[1]
  const cross = abX * acY - abY * acX
  const scale = Math.max(1, Math.abs(abX), Math.abs(abY), Math.abs(acX), Math.abs(acY))
  if (Math.abs(cross) > Number.EPSILON * FLOATING_COST_EPSILON_FACTOR * scale * scale) return false
  const dot = abX * acX + abY * acY
  const squaredLength = acX * acX + acY * acY
  if (squaredLength === 0) return false
  return dot >= 0 && dot <= squaredLength
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
  return compareFloating(a.costMeters, b.costMeters)
    || compareFloating(nullableMetric(a.metrics.endpointDistanceMeters), nullableMetric(b.metrics.endpointDistanceMeters))
    || compareFloating(b.metrics.matchedSpanMeters, a.metrics.matchedSpanMeters)
    || compareFloating(a.metrics.meanStopDistanceMeters, b.metrics.meanStopDistanceMeters)
    || compareFloating(a.metrics.maxStopDistanceMeters, b.metrics.maxStopDistanceMeters)
}

function assignmentsAreExactlyEquivalent(best: AssignmentSolution, alternative: AssignmentSolution): boolean {
  if (alternative.cardinality !== best.cardinality) return false
  const differing = differingAssignmentCosts(best, alternative)
  return atOrBelowFloatingThreshold(
    differing.alternativeCostMeters,
    differing.bestCostMeters,
  )
}

function assignmentsAreToleranceEquivalent(
  best: AssignmentSolution,
  alternative: AssignmentSolution,
  options: ResolvedOptions,
): boolean {
  if (alternative.cardinality !== best.cardinality) return false
  const differing = differingAssignmentCosts(best, alternative)
  const delta = differing.alternativeCostMeters - differing.bestCostMeters
  if (atOrBelowFloatingThreshold(delta, 0)) return true
  const toleranceMeters = Math.max(
    options.ambiguityAbsoluteMeters,
    Math.abs(differing.bestCostMeters) * options.ambiguityRelativeRatio,
  )
  // The exact boundary is inclusive. Common fixed edges have already been removed.
  return atOrBelowFloatingThreshold(delta, toleranceMeters)
}

function differingAssignmentCosts(
  best: AssignmentSolution,
  alternative: AssignmentSolution,
): { bestCostMeters: number; alternativeCostMeters: number } {
  const bestKeys = new Set(best.edges.map(assignmentEdgeKey))
  const alternativeKeys = new Set(alternative.edges.map(assignmentEdgeKey))
  return {
    bestCostMeters: best.edges
      .filter((edge) => !alternativeKeys.has(assignmentEdgeKey(edge)))
      .reduce((total, edge) => total + edge.costMeters, 0),
    alternativeCostMeters: alternative.edges
      .filter((edge) => !bestKeys.has(assignmentEdgeKey(edge)))
      .reduce((total, edge) => total + edge.costMeters, 0),
  }
}

function compareAssignmentSolution(a: AssignmentSolution, b: AssignmentSolution): number {
  if (a.cardinality !== b.cardinality) return b.cardinality - a.cardinality
  return compareFloating(a.costMeters, b.costMeters) || a.key.localeCompare(b.key)
}

function emptyAssignment(): AssignmentSolution {
  return { cardinality: 0, costMeters: 0, edges: [], key: '' }
}

function impossibleAssignment(): AssignmentSolution {
  return {
    cardinality: Number.NEGATIVE_INFINITY,
    costMeters: Number.POSITIVE_INFINITY,
    edges: [],
    key: '~',
  }
}

function insertAssignmentEdge(edges: AssignmentEdge[], edge: AssignmentEdge): AssignmentEdge[] {
  return sortAssignmentEdges([...edges, edge])
}

function sortAssignmentEdges(edges: AssignmentEdge[]): AssignmentEdge[] {
  return [...edges].sort((a, b) =>
    a.patternIndex - b.patternIndex || a.shapeIndex - b.shapeIndex)
}

function assignmentKey(edges: AssignmentEdge[]): string {
  return edges.map(assignmentEdgeKey).join('|')
}

function assignmentEdgeKey(edge: AssignmentEdge): string {
  return `${edge.patternIndex.toString().padStart(8, '0')}:${edge.shapeIndex.toString().padStart(8, '0')}`
}

function stopDistanceObjective(meanStopDistanceMeters: number, maxStopDistanceMeters: number): number {
  return meanStopDistanceMeters + maxStopDistanceMeters * STOP_DISTANCE_MAX_WEIGHT
}

function candidateShapeIds(pairs: ScoredPair[]): string[] {
  return [...new Set(pairs.map((pair) => pair.shape.shapeId))].sort()
}

function floatingCostEpsilon(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(
    NUMERIC_METERS_EPSILON,
    Number.EPSILON * FLOATING_COST_EPSILON_FACTOR * Math.max(1, Math.abs(value)),
  )
}

/** Inclusive threshold comparison with only machine-scale floating tolerance. */
function atOrBelowFloatingThreshold(value: number, limit: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(limit)) return false
  return value <= limit + floatingCostEpsilon(limit)
}

function compareFloating(a: number, b: number): number {
  if (a === b) return 0
  if (Number.isNaN(a)) return 1
  if (Number.isNaN(b)) return -1
  if (!Number.isFinite(a) || !Number.isFinite(b)) return a < b ? -1 : 1
  const epsilon = floatingCostEpsilon(Math.max(Math.abs(a), Math.abs(b)))
  if (Math.abs(a - b) <= epsilon) return 0
  return a < b ? -1 : 1
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

function range(length: number): number[] {
  return Array.from({ length }, (_unused, index) => index)
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
    closureGapDistanceMeters: metrics.closureGapDistanceMeters === null
      ? null
      : roundMetric(metrics.closureGapDistanceMeters),
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
