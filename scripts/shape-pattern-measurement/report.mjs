import { mkdir } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { HARNESS_VERSION, MATCHER_SOURCE } from './constants.mjs'
import { executeMatcher } from './instrument-loader.mjs'
import {
  accumulateDirection2, accumulateOutcomes, buildOutliers, buildSummary, countBy,
  createDirection2Counts, createOutcomeCounts, deterministicContentHash,
  maxCandidateUpdateTime, maxRawUpdateTime, median,
} from './report-analysis.mjs'
import {
  assertCollectorsDeterministic, classifyClosure, comparePairRecord,
  createInstrumentationCollector, mergePairRecords, normalizeCoordinates,
} from './report-collector.mjs'
import { toJsonLines, validateReport } from './report-schema.mjs'
import { atomicWrite, stableStringify, writeJson } from './util.mjs'

export async function createMeasurementReport({
  candidateBundle,
  rawManifest,
  options,
  repositoryMainSha,
  matcherSourcePath = MATCHER_SOURCE,
}) {
  const startedAt = new Date().toISOString()
  const partitions = []
  const pairs = []
  const outcomeCounts = createOutcomeCounts()
  const direction2 = createDirection2Counts()
  let matcherSourceSha256 = null
  let matcherSourceGitBlobSha1 = null

  for (const partition of candidateBundle.partitions) {
    const measured = await measurePartition(partition, options, matcherSourcePath)
    matcherSourceSha256 ??= measured.sourceSha256
    matcherSourceGitBlobSha1 ??= measured.sourceGitBlobSha1
    partitions.push(measured.partitionRecord)
    pairs.push(...measured.pairRecords)
    accumulateOutcomes(outcomeCounts, measured.result)
    accumulateDirection2(direction2, partition, measured.result)
  }

  const metadata = {
    schemaVersion: 1,
    repositoryMainSha,
    matcherSourcePath,
    matcherSourceSha256,
    matcherSourceGitBlobSha1,
    harnessVersion: HARNESS_VERSION,
    nodeVersion: process.version,
    os: { platform: platform(), release: release() },
    cpuModel: cpus()[0]?.model ?? 'unknown',
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem(),
    fetchedAt: rawManifest.fetchedAt ?? null,
    startedAt,
    completedAt: new Date().toISOString(),
    selectedCities: options.cities,
    includeIntercity: options.includeIntercity,
    endpointContentHashes: (rawManifest.endpoints ?? []).map((entry) => ({
      endpointCategory: entry.category,
      city: entry.city,
      sourceScope: entry.scope,
      contentHash: entry.contentHash,
    })),
    tdxPayloadMaxUpdateTime: maxRawUpdateTime(rawManifest) ?? maxCandidateUpdateTime(candidateBundle),
    mode: options.instrumented ? 'instrumented' : 'uninstrumented',
    warmupCount: options.warmup,
    iterationCount: options.iterations,
  }
  const report = {
    metadata,
    partitions: partitions.sort(comparePartitionRecord),
    pairs: pairs.sort(comparePairRecord),
    outcomes: { ...outcomeCounts, direction2 },
    outliers: buildOutliers(partitions, pairs, options.topOutliers),
    summary: buildSummary(partitions, pairs),
  }
  report.metadata.deterministicContentHash = deterministicContentHash(report)
  validateReport(report)
  return report
}

export async function writeMeasurementReport(report, reportDir) {
  await mkdir(reportDir, { recursive: true })
  await writeJson(join(reportDir, 'metadata.json'), report.metadata)
  await atomicWrite(join(reportDir, 'partitions.jsonl'), toJsonLines(report.partitions))
  await atomicWrite(join(reportDir, 'pairs.jsonl'), toJsonLines(report.pairs))
  await writeJson(join(reportDir, 'outcomes.json'), report.outcomes)
  await writeJson(join(reportDir, 'outliers.json'), report.outliers)
  await writeJson(join(reportDir, 'summary.json'), report.summary)
}

async function measurePartition(partition, options, matcherSourcePath) {
  for (let index = 0; index < options.warmup; index += 1) {
    await executeMatcher({
      patterns: partition.patterns,
      shapes: partition.shapes,
      instrumented: options.instrumented,
      expectedMatcherSha256: options.expectedMatcherSha256,
      matcherSourcePath,
      generatedDir: options.generatedDir,
    })
  }

  let canonicalResult = null
  let sourceSha256 = null
  let sourceGitBlobSha1 = null
  const iterationTimes = []
  const collectors = []
  const rss = []
  const heap = []

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    const collector = createInstrumentationCollector(partition)
    if (options.instrumented) {
      const plain = await executeMatcher({
        patterns: partition.patterns,
        shapes: partition.shapes,
        instrumented: false,
        matcherSourcePath,
        generatedDir: options.generatedDir,
      })
      const instrumented = await timedExecution(() => executeMatcher({
        patterns: partition.patterns,
        shapes: partition.shapes,
        instrumented: true,
        expectedMatcherSha256: options.expectedMatcherSha256,
        matcherSourcePath,
        generatedDir: options.generatedDir,
        onMeasurement: collector.observe,
      }))
      if (stableStringify(plain.result) !== stableStringify(instrumented.value.result)) {
        throw new Error(`Instrumented matcher result differs for partition ${partition.partitionId}`)
      }
      iterationTimes.push(instrumented.elapsedMs)
      sourceSha256 = instrumented.value.sourceSha256
      sourceGitBlobSha1 = instrumented.value.sourceGitBlobSha1
      canonicalResult ??= instrumented.value.result
    } else {
      const plain = await timedExecution(() => executeMatcher({
        patterns: partition.patterns,
        shapes: partition.shapes,
        instrumented: false,
        matcherSourcePath,
        generatedDir: options.generatedDir,
      }))
      iterationTimes.push(plain.elapsedMs)
      sourceSha256 = plain.value.sourceSha256
      sourceGitBlobSha1 = plain.value.sourceGitBlobSha1
      canonicalResult ??= plain.value.result
    }
    const memory = process.memoryUsage()
    rss.push(memory.rss)
    heap.push(memory.heapUsed)
    collector.finish()
    collectors.push(collector.snapshot())
  }

  assertCollectorsDeterministic(collectors, partition.partitionId)
  const collector = collectors[0] ?? createInstrumentationCollector(partition).snapshot()
  const pairRecords = mergePairRecords(partition, collector.pairs)
  const compatibleEdgeCount = options.instrumented
    ? pairRecords.filter((record) => record.compatible === true).length
    : null
  const partitionRecord = {
    partitionId: partition.partitionId,
    sourceScope: partition.sourceScope,
    city: partition.city,
    routeUid: partition.routeUid,
    direction: partition.direction,
    patternCount: partition.stats.patternCount,
    shapeCount: partition.stats.shapeCount,
    minSideCount: partition.stats.minSideCount,
    candidateMultiplicity: partition.stats.candidateMultiplicity,
    completeIdentityCount: partition.stats.completeIdentityCount,
    duplicateIdentityCount: partition.stats.duplicateIdentityCount,
    contradictoryIdentityCount: partition.stats.contradictoryIdentityCount,
    compatibleEdgeCount,
    compatibleEdgeDensity: compatibleEdgeCount === null ? null
      : partition.stats.patternCount && partition.stats.shapeCount
        ? compatibleEdgeCount / (partition.stats.patternCount * partition.stats.shapeCount)
        : 0,
    compatibleEdgesMeasured: options.instrumented,
    bestAssignmentTimeMs: collector.assignment.bestTimeMs,
    ambiguityProofTimeMs: collector.assignment.forcedMatchTimeMs + collector.assignment.forcedUnmatchedTimeMs,
    partitionWallTimeMs: median(iterationTimes),
    matchedCount: canonicalResult.matches.length,
    unresolvedCount: canonicalResult.unresolved.length,
    unusedShapeCount: canonicalResult.unusedShapeIds.length,
    outcomeReasonCounts: countBy(canonicalResult.unresolved, (entry) => entry.reason),
    rejectedShapeReasonCounts: countBy(canonicalResult.rejectedShapes, (entry) => entry.reason),
    rssBytes: median(rss),
    heapUsedBytes: median(heap),
    assignmentBestSolveCount: collector.assignment.bestCount,
    forcedMatchSolveCount: collector.assignment.forcedMatchCount,
    forcedUnmatchedSolveCount: collector.assignment.forcedUnmatchedCount,
    activeMaskPeak: collector.assignment.activeMaskPeak,
    direction2ClosureCounts: partition.direction === 2 ? countBy(
      partition.shapes,
      (shape) => classifyClosure(2, normalizeCoordinates(shape.coordinates)).classification,
    ) : {},
  }
  return { result: canonicalResult, partitionRecord, pairRecords, sourceSha256, sourceGitBlobSha1 }
}

async function timedExecution(run) {
  const startedAt = performance.now()
  const value = await run()
  return { value, elapsedMs: performance.now() - startedAt }
}

function comparePartitionRecord(a, b) {
  return a.partitionId.localeCompare(b.partitionId)
}
