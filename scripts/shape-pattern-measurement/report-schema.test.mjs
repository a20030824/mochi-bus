import { describe, expect, it } from 'vitest'
import { validateCompletionManifest, validateReport } from './report-schema.mjs'

const zeroDistribution = () => ({
  count: 0, min: null, median: null, p75: null, p90: null, p95: null, p99: null, max: null,
})
const oneDistribution = () => ({
  count: 1, min: 1, median: 1, p75: 1, p90: 1, p95: 1, p99: 1, max: 1,
})

function validReport({ instrumented = false } = {}) {
  const partitionId = 'a'.repeat(24)
  const partition = {
    partitionId,
    sourceScope: 'city', city: 'Taipei', routeUid: 'R1', direction: 0,
    patternCount: 1, shapeCount: 1, minSideCount: 1, candidateMultiplicity: 1,
    completeIdentityCount: 2, duplicateIdentityCount: 0, contradictoryIdentityCount: 0,
    compatibleEdgeCount: instrumented ? 1 : null,
    compatibleEdgeDensity: instrumented ? 1 : null,
    pairMetricsAvailable: instrumented,
    bestAssignmentTimeMs: instrumented ? 0 : null,
    ambiguityProofTimeMs: instrumented ? 0 : null,
    matcherLatencyMs: 0,
    matcherIterationSamplesMs: [0],
    matchedCount: 1, unresolvedCount: 0, unusedShapeCount: 0,
    outcomeReasonCounts: {}, rejectedShapeReasonCounts: {},
    memoryObservation: {
      rssBeforeBytes: 100, rssAfterBytes: 100, rssDeltaBytes: 0,
      heapBeforeBytes: 50, heapAfterBytes: 50, heapDeltaBytes: 0,
      sampleCount: 1, forcedGc: false, peakClaimed: false,
    },
    assignmentBestSolveCount: instrumented ? 0 : null,
    forcedMatchSolveCount: instrumented ? 0 : null,
    forcedUnmatchedSolveCount: instrumented ? 0 : null,
    activeMaskPeak: instrumented ? null : null,
    direction2ClosureCounts: null,
  }
  const pair = {
    partitionId, patternId: 'p1', shapeId: 's1', stopCount: 2,
    rawCoordinateCount: 2, normalizedCoordinateCount: 2, segmentCount: 1,
    direction2UnwrappedSegmentCount: null,
    duplicateCoordinateRemovalCount: null, collinearCoordinateRemovalCount: null,
    closureClassification: 'not-direction-2', closureGapDistanceMeters: null,
    projectionCandidateCount: 4, peakFrontierWidth: 1, retainedNodeCount: 1,
    parentNodeCount: 0, pathKeyApproximateBytes: 8,
    forwardTimeMs: 0, reverseTimeMs: 0,
    costObjectiveSolveTimeMs: 0, spanObjectiveSolveTimeMs: null,
    projectionOutcomes: [
      { orientation: 'forward', objective: 'cost', status: 'success', elapsedMs: 0 },
      { orientation: 'reverse', objective: 'cost', status: 'success', elapsedMs: 0 },
    ],
    pairTimeMs: 0, compatible: true, status: 'compatible', instrumented: true,
  }
  return {
    metadata: {
      schemaVersion: 2,
      runId: `${instrumented ? 'instrumented' : 'uninstrumented'}-aaaaaaaaaaaa-bbbbbbbbbbbb-20260722010000-12345678`,
      repositoryMainSha: '1'.repeat(40),
      matcherSourcePath: 'src/domain/map/shape-pattern-matcher.ts',
      matcherSourceSha256: '2'.repeat(64), matcherSourceGitBlobSha1: '3'.repeat(40),
      harnessVersion: 2, nodeVersion: 'v22.0.0',
      os: { platform: 'linux', release: 'test' }, cpuModel: 'test', logicalCpuCount: 1,
      totalMemoryBytes: 1024, startedAt: '2026-07-22T00:00:00.000Z', completedAt: '2026-07-22T00:00:01.000Z',
      provenance: {
        fetchedAt: '2026-07-21T00:00:00.000Z', selectedCities: ['Taipei'], includeIntercity: false,
        endpoints: [
          { endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape', fileName: 'city-Taipei-shape.json', contentHash: '4'.repeat(64), itemCount: 1, maxUpdateTime: null },
          { endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route', fileName: 'city-Taipei-stop-of-route.json', contentHash: '5'.repeat(64), itemCount: 1, maxUpdateTime: null },
        ],
        bundleContentHash: '6'.repeat(64), tdxPayloadMaxUpdateTime: null,
      },
      mode: instrumented ? 'instrumented' : 'uninstrumented', pairMetricsAvailable: instrumented,
      warmupCount: 1, iterationCount: 1,
      loaderTimings: {
        plain: { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 },
        instrumented: instrumented ? { sourceVerificationTimeMs: 0, transpileTimeMs: 0, importTimeMs: 0 } : null,
      },
      memoryPolicy: 'before-after-process-memory-no-forced-gc-no-peak-claim',
      deterministicContentHash: '7'.repeat(64),
    },
    partitions: [partition],
    pairs: instrumented ? [pair] : [],
    outcomes: {
      exactIdentity: 1, geometry: 0,
      invalidPattern: 0, noCompatibleShape: 0, compatibleShapeAssigned: 0,
      assignmentAmbiguous: 0, toleranceEquivalentAlternatives: 0,
      contradictoryCompleteIdentity: 0, nearClosedGeometryDisabled: 0,
      rejectedOrInvalidShapes: 0, rejectedShapeReasons: {}, sourceRejections: {}, unusedShapes: 0,
      direction2: {
        pairMetricsAvailable: instrumented,
        trulyClosed: instrumented ? 0 : null,
        nearClosed: instrumented ? 0 : null,
        openOrInvalid: instrumented ? 0 : null,
        identitySuccess: 0, geometrySuccess: 0, failClosedUnresolved: 0, rejectedCount: 0,
      },
    },
    outliers: {
      largestPatternPartitions: [partition], largestShapePartitions: [partition],
      largestMinSidePartitions: [partition], densestCompatibleMatrices: instrumented ? [partition] : [],
      mostStopsPairs: instrumented ? [pair] : [], mostSegmentsPairs: instrumented ? [pair] : [],
      widestFrontierPairs: instrumented ? [pair] : [], mostRetainedNodesPairs: instrumented ? [pair] : [],
      slowestPairScoring: instrumented ? [pair] : [], slowestAssignmentProofs: instrumented ? [partition] : [],
      slowestPartitions: [partition], highestRssDeltaPartitions: [partition], highestHeapDeltaPartitions: [partition],
      direction2MostSiblings: [],
    },
    summary: { patternCount: oneDistribution(), pairLatencyMs: instrumented ? { ...oneDistribution(), min: 0, median: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0 } : zeroDistribution() },
  }
}

function clone(value) { return structuredClone(value) }

describe('measurement report schema and reconciliation', () => {
  it('accepts valid instrumented and uninstrumented reports', () => {
    expect(() => validateReport(validReport())).not.toThrow()
    expect(() => validateReport(validReport({ instrumented: true }))).not.toThrow()
  })

  it.each([
    ['negative patternCount', (report) => { report.partitions[0].patternCount = -5 }],
    ['invalid direction', (report) => { report.partitions[0].direction = 99 }],
    ['undefined partitionId', (report) => { report.partitions[0].partitionId = undefined }],
    ['density outside range', (report) => { report.partitions[0].compatibleEdgeDensity = 12 }],
    ['pattern accounting mismatch', (report) => { report.partitions[0].matchedCount = 0 }],
    ['NaN', (report) => { report.partitions[0].matcherLatencyMs = NaN }],
    ['Infinity', (report) => { report.partitions[0].matcherLatencyMs = Infinity }],
    ['illegal null', (report) => { report.partitions[0].matcherLatencyMs = null }],
    ['unknown unresolved reason', (report) => { report.partitions[0].outcomeReasonCounts['new-reason'] = 1 }],
    ['unknown field', (report) => { report.partitions[0].surprise = true }],
  ])('rejects %s', (_name, mutate) => {
    const report = clone(validReport({ instrumented: true }))
    mutate(report)
    expect(() => validateReport(report)).toThrow()
  })

  it('rejects a pair that references a nonexistent partition', () => {
    const report = validReport({ instrumented: true })
    report.pairs[0].partitionId = 'b'.repeat(24)
    expect(() => validateReport(report)).toThrow(/missing partition/)
  })

  it('rejects count-zero distributions with invented zero values and unordered percentiles', () => {
    const first = validReport()
    first.summary.pairLatencyMs.min = 0
    expect(() => validateReport(first)).toThrow(/null metrics/)

    const second = validReport()
    second.summary.patternCount.p90 = 0
    expect(() => validateReport(second)).toThrow(/not ordered/)
  })

  it('rejects a completion manifest missing any report hash', () => {
    const completion = {
      schemaVersion: 2,
      runId: 'uninstrumented-aaaaaaaaaaaa-bbbbbbbbbbbb-20260722010000-12345678',
      mode: 'uninstrumented', matcherSourceSha256: '2'.repeat(64), bundleContentHash: '6'.repeat(64),
      reportFiles: {
        'metadata.json': '1'.repeat(64), 'partitions.jsonl': '2'.repeat(64),
        'pairs.jsonl': '3'.repeat(64), 'outcomes.json': '4'.repeat(64),
        'outliers.json': '5'.repeat(64),
      },
      publishedAt: '2026-07-22T00:00:00.000Z',
    }
    expect(() => validateCompletionManifest(completion)).toThrow(/reportFiles/)
  })
})
