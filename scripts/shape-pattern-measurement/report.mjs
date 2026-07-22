import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises'
import { cpus, platform, release, totalmem } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import {
  COMPLETION_FILE, HARNESS_VERSION, MATCHER_SOURCE, REPORT_FILES,
  REPORT_SCHEMA_VERSION,
} from './constants.mjs'
import { collectorFailure, loadMatcherModule as defaultLoadMatcherModule } from './instrument-loader.mjs'
import {
  accumulateDirection2, accumulateOutcomes, buildOutliers, buildSummary,
  countBy, createDirection2Counts, createOutcomeCounts, deterministicContentHash,
  maxRawUpdateTime,
} from './report-analysis.mjs'
import {
  aggregatePairIterations, assertCollectorsDeterministic,
  createInstrumentationCollector,
} from './report-collector.mjs'
import {
  parseJsonLines, toJsonLines, validateCompletionManifest, validateReport,
} from './report-schema.mjs'
import { atomicWrite, median, sha256Hex, stableStringify } from './util.mjs'

export async function createMeasurementReport({
  candidateBundle,
  rawManifest,
  options,
  repositoryMainSha,
  matcherSourcePath = MATCHER_SOURCE,
}, dependencies = {}) {
  const loadMatcherModule = dependencies.loadMatcherModule ?? defaultLoadMatcherModule
  const startedAt = new Date().toISOString()
  let activeCollector = null
  const plain = await loadMatcherModule({
    instrumented: false,
    matcherSourcePath,
    generatedRunDir: options.generatedRunDir,
  })
  let instrumented = null
  try {
    if (options.instrumented) {
      instrumented = await loadMatcherModule({
        instrumented: true,
        expectedMatcherSha256: options.expectedMatcherSha256,
        matcherSourcePath,
        generatedRunDir: options.generatedRunDir,
        onMeasurement: (event, payload) => activeCollector?.observe(event, payload),
      })
      if (plain.sourceSha256 !== instrumented.sourceSha256
        || plain.sourceGitBlobSha1 !== instrumented.sourceGitBlobSha1) {
        throw new Error('Plain and instrumented matcher revisions differ')
      }
    }

    const partitions = []
    const pairs = []
    const outcomeCounts = createOutcomeCounts(candidateBundle)
    const direction2 = createDirection2Counts(Boolean(options.instrumented))

    for (const partition of candidateBundle.partitions) {
      const measured = await measurePartition({
        partition,
        options,
        plain,
        instrumented,
        setActiveCollector: (collector) => { activeCollector = collector },
      })
      partitions.push(measured.partitionRecord)
      pairs.push(...measured.pairRecords)
      accumulateOutcomes(outcomeCounts, measured.result)
      accumulateDirection2(direction2, partition, measured.result, measured.collectorSnapshot)
    }

    const mode = options.instrumented ? 'instrumented' : 'uninstrumented'
    const matcherSourceSha256 = plain.sourceSha256
    const metadata = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      runId: makeRunId(mode, repositoryMainSha, matcherSourceSha256),
      repositoryMainSha,
      matcherSourcePath,
      matcherSourceSha256,
      matcherSourceGitBlobSha1: plain.sourceGitBlobSha1,
      harnessVersion: HARNESS_VERSION,
      nodeVersion: process.version,
      os: { platform: platform(), release: release() },
      cpuModel: cpus()[0]?.model ?? 'unknown',
      logicalCpuCount: Math.max(1, cpus().length),
      totalMemoryBytes: totalmem(),
      startedAt,
      completedAt: new Date().toISOString(),
      provenance: {
        fetchedAt: rawManifest.fetchedAt,
        selectedCities: [...rawManifest.cities],
        includeIntercity: rawManifest.includeIntercity,
        endpoints: [...rawManifest.endpoints].map((entry) => ({
          endpointId: entry.endpointId,
          scope: entry.scope,
          city: entry.city,
          category: entry.category,
          fileName: entry.fileName,
          contentHash: entry.contentHash,
          itemCount: entry.itemCount,
          maxUpdateTime: entry.maxUpdateTime,
        })),
        bundleContentHash: rawManifest.bundleContentHash,
        tdxPayloadMaxUpdateTime: maxRawUpdateTime(rawManifest),
      },
      mode,
      pairMetricsAvailable: Boolean(options.instrumented),
      warmupCount: options.warmup,
      iterationCount: options.iterations,
      loaderTimings: {
        plain: plain.loaderTimings,
        instrumented: instrumented?.loaderTimings ?? null,
      },
      memoryPolicy: 'before-after-process-memory-no-forced-gc-no-peak-claim',
      deterministicContentHash: '0'.repeat(64),
    }
    const orderedPartitions = partitions.sort(comparePartitionRecord)
    const orderedPairs = pairs.sort(comparePairRecord)
    const report = {
      metadata,
      partitions: orderedPartitions,
      pairs: orderedPairs,
      outcomes: { ...outcomeCounts, direction2 },
      outliers: buildOutliers(orderedPartitions, orderedPairs, options.topOutliers),
      summary: buildSummary(orderedPartitions, orderedPairs),
    }
    report.metadata.deterministicContentHash = deterministicContentHash(report)
    validateReport(report)
    return report
  } finally {
    activeCollector = null
    const errors = []
    if (instrumented) {
      try { await instrumented.dispose() } catch (error) { errors.push(error) }
    }
    try { await plain.dispose() } catch (error) { errors.push(error) }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Matcher module cleanup failed')
  }
}

async function measurePartition({ partition, options, plain, instrumented, setActiveCollector }) {
  for (let index = 0; index < options.warmup; index += 1) {
    if (options.instrumented) {
      const warmCollector = createInstrumentationCollector(partition)
      setActiveCollector(warmCollector)
      const plainResult = plain.invoke(partition.patterns, partition.shapes)
      const instrumentedResult = instrumented.invoke(partition.patterns, partition.shapes)
      assertSameResult(plainResult, instrumentedResult, partition.partitionId)
      warmCollector.finish()
    } else {
      plain.invoke(partition.patterns, partition.shapes)
    }
  }

  let canonicalResult = null
  const matcherSamples = []
  const beforeSamples = []
  const afterSamples = []
  const collectorSnapshots = []

  for (let iteration = 0; iteration < options.iterations; iteration += 1) {
    let result
    const before = process.memoryUsage()
    if (options.instrumented) {
      const collector = createInstrumentationCollector(partition)
      setActiveCollector(collector)
      const expected = plain.invoke(partition.patterns, partition.shapes)
      const measured = timedInvoke(() => instrumented.invoke(partition.patterns, partition.shapes))
      result = measured.value
      matcherSamples.push(measured.elapsedMs)
      assertSameResult(expected, result, partition.partitionId)
      collector.finish()
      collectorSnapshots.push(collector.snapshot())
    } else {
      const measured = timedInvoke(() => plain.invoke(partition.patterns, partition.shapes))
      result = measured.value
      matcherSamples.push(measured.elapsedMs)
    }
    const after = process.memoryUsage()
    beforeSamples.push(before)
    afterSamples.push(after)
    if (canonicalResult === null) canonicalResult = result
    else assertSameResult(canonicalResult, result, partition.partitionId)
  }
  setActiveCollector(null)

  const collectorError = instrumented?.takeCollectorError?.() ?? null
  if (collectorError) throw collectorFailure(collectorError)

  assertCollectorsDeterministic(collectorSnapshots, partition.partitionId)
  const collectorSnapshot = collectorSnapshots[0] ?? { shapes: [], pairs: [], assignment: emptyAssignmentSnapshot() }
  const pairRecords = options.instrumented
    ? aggregatePairIterations(collectorSnapshots, partition.partitionId)
    : []
  const compatibleEdgeCount = options.instrumented
    ? pairRecords.filter((record) => record.compatible === true).length
    : null
  const assignment = aggregateAssignment(collectorSnapshots)
  const rssBeforeBytes = median(beforeSamples.map((sample) => sample.rss))
  const rssAfterBytes = median(afterSamples.map((sample) => sample.rss))
  const heapBeforeBytes = median(beforeSamples.map((sample) => sample.heapUsed))
  const heapAfterBytes = median(afterSamples.map((sample) => sample.heapUsed))

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
      : partition.stats.candidateMultiplicity > 0
        ? compatibleEdgeCount / partition.stats.candidateMultiplicity
        : 0,
    pairMetricsAvailable: Boolean(options.instrumented),
    bestAssignmentTimeMs: options.instrumented ? assignment.bestTimeMs : null,
    ambiguityProofTimeMs: options.instrumented ? assignment.ambiguityProofTimeMs : null,
    matcherLatencyMs: median(matcherSamples),
    matcherIterationSamplesMs: matcherSamples,
    matchedCount: canonicalResult.matches.length,
    unresolvedCount: canonicalResult.unresolved.length,
    unusedShapeCount: canonicalResult.unusedShapeIds.length,
    outcomeReasonCounts: countBy(canonicalResult.unresolved, (entry) => entry.reason),
    rejectedShapeReasonCounts: countBy(canonicalResult.rejectedShapes, (entry) => entry.reason),
    memoryObservation: {
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
      heapBeforeBytes,
      heapAfterBytes,
      heapDeltaBytes: heapAfterBytes - heapBeforeBytes,
      sampleCount: matcherSamples.length,
      forcedGc: false,
      peakClaimed: false,
    },
    assignmentBestSolveCount: options.instrumented ? assignment.bestCount : null,
    forcedMatchSolveCount: options.instrumented ? assignment.forcedMatchCount : null,
    forcedUnmatchedSolveCount: options.instrumented ? assignment.forcedUnmatchedCount : null,
    activeMaskPeak: options.instrumented ? assignment.activeMaskPeak : null,
    direction2ClosureCounts: options.instrumented && partition.direction === 2
      ? countBy(collectorSnapshot.shapes.filter((shape) => shape.direction === 2), (shape) => shape.closureClassification)
      : null,
  }
  return { result: canonicalResult, partitionRecord, pairRecords, collectorSnapshot }
}

function aggregateAssignment(snapshots) {
  if (!snapshots.length) return {
    bestCount: 0, forcedMatchCount: 0, forcedUnmatchedCount: 0,
    bestTimeMs: 0, ambiguityProofTimeMs: 0, activeMaskPeak: null,
  }
  const first = snapshots[0].assignment
  const best = snapshots.flatMap((snapshot) => snapshot.assignment.bestTimeSamplesMs)
  const forcedMatch = snapshots.flatMap((snapshot) => snapshot.assignment.forcedMatchTimeSamplesMs)
  const forcedUnmatched = snapshots.flatMap((snapshot) => snapshot.assignment.forcedUnmatchedTimeSamplesMs)
  return {
    bestCount: first.bestCount,
    forcedMatchCount: first.forcedMatchCount,
    forcedUnmatchedCount: first.forcedUnmatchedCount,
    bestTimeMs: medianOrZero(best),
    ambiguityProofTimeMs: medianOrZero(forcedMatch) + medianOrZero(forcedUnmatched),
    activeMaskPeak: first.activeMaskPeak,
  }
}

function emptyAssignmentSnapshot() {
  return {
    bestCount: 0, forcedMatchCount: 0, forcedUnmatchedCount: 0,
    bestTimeSamplesMs: [], forcedMatchTimeSamplesMs: [], forcedUnmatchedTimeSamplesMs: [],
    activeMaskPeak: null,
  }
}
function medianOrZero(values) { return values.length ? median(values) : 0 }
function timedInvoke(run) { const startedAt = performance.now(); const value = run(); return { value, elapsedMs: performance.now() - startedAt } }
function assertSameResult(expected, actual, partitionId) { if (stableStringify(expected) !== stableStringify(actual)) throw new Error(`Matcher result is not deterministic for partition ${partitionId}`) }
function comparePartitionRecord(a, b) { return a.partitionId.localeCompare(b.partitionId) }
function comparePairRecord(a, b) { return `${a.partitionId}\0${a.patternId}\0${a.shapeId}`.localeCompare(`${b.partitionId}\0${b.patternId}\0${b.shapeId}`) }
function makeRunId(mode, repositoryMainSha, matcherSha) {
  const timestamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)
  return `${mode}-${repositoryMainSha.slice(0, 12)}-${matcherSha.slice(0, 12)}-${timestamp}-${randomUUID().replaceAll('-', '').slice(0, 8)}`
}

export async function publishMeasurementReport(report, reportRoot, dependencies = {}) {
  validateReport(report)
  const atomicWriter = dependencies.atomicWriter ?? atomicWrite
  const validateDirectory = dependencies.validateDirectory ?? validateTemporaryReportDirectory
  await mkdir(reportRoot, { recursive: true })
  const finalDirectory = join(reportRoot, report.metadata.runId)
  if (await exists(finalDirectory)) throw new Error(`Report run already exists: ${report.metadata.runId}`)
  const temporaryDirectory = await mkdtemp(join(reportRoot, `.${report.metadata.runId}-`))
  try {
    const contents = reportFileContents(report)
    for (const file of REPORT_FILES) await atomicWriter(join(temporaryDirectory, file), contents[file])
    await validateDirectory(temporaryDirectory)
    const reportFiles = Object.fromEntries(REPORT_FILES.map((file) => [file, sha256Hex(contents[file])]))
    const completion = {
      schemaVersion: REPORT_SCHEMA_VERSION,
      runId: report.metadata.runId,
      mode: report.metadata.mode,
      matcherSourceSha256: report.metadata.matcherSourceSha256,
      bundleContentHash: report.metadata.provenance.bundleContentHash,
      reportFiles,
      publishedAt: new Date().toISOString(),
    }
    validateCompletionManifest(completion)
    await atomicWriter(join(temporaryDirectory, COMPLETION_FILE), `${stableStringify(completion, 2)}\n`)
    await validatePublishedDirectory(temporaryDirectory)
    if (await exists(finalDirectory)) throw new Error(`Report run already exists: ${report.metadata.runId}`)
    await rename(temporaryDirectory, finalDirectory)
    return finalDirectory
  } catch (error) {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

export async function validatePublishedDirectory(runDirectory) {
  const completion = validateCompletionManifest(JSON.parse(await readFile(join(runDirectory, COMPLETION_FILE), 'utf8')))
  const contents = {}
  for (const file of REPORT_FILES) {
    contents[file] = await readFile(join(runDirectory, file), 'utf8')
    const actual = sha256Hex(contents[file])
    if (actual !== completion.reportFiles[file]) throw new Error(`Report content hash mismatch for ${file}`)
  }
  const report = parseReportContents(contents)
  validateReport(report)
  if (report.metadata.runId !== completion.runId
    || report.metadata.mode !== completion.mode
    || report.metadata.matcherSourceSha256 !== completion.matcherSourceSha256
    || report.metadata.provenance.bundleContentHash !== completion.bundleContentHash) {
    throw new Error('Completion marker disagrees with report metadata')
  }
  return report
}

export async function readPublishedReport(runDirectory) {
  return validatePublishedDirectory(runDirectory)
}

async function validateTemporaryReportDirectory(runDirectory) {
  const contents = {}
  for (const file of REPORT_FILES) contents[file] = await readFile(join(runDirectory, file), 'utf8')
  return validateReport(parseReportContents(contents))
}

function reportFileContents(report) {
  return {
    'metadata.json': `${stableStringify(report.metadata, 2)}\n`,
    'partitions.jsonl': toJsonLines(report.partitions),
    'pairs.jsonl': toJsonLines(report.pairs),
    'outcomes.json': `${stableStringify(report.outcomes, 2)}\n`,
    'outliers.json': `${stableStringify(report.outliers, 2)}\n`,
    'summary.json': `${stableStringify(report.summary, 2)}\n`,
  }
}
function parseReportContents(contents) {
  return {
    metadata: JSON.parse(contents['metadata.json']),
    partitions: parseJsonLines(contents['partitions.jsonl']),
    pairs: parseJsonLines(contents['pairs.jsonl']),
    outcomes: JSON.parse(contents['outcomes.json']),
    outliers: JSON.parse(contents['outliers.json']),
    summary: JSON.parse(contents['summary.json']),
  }
}
async function exists(path) { try { await access(path); return true } catch { return false } }
