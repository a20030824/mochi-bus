import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
import ts from 'typescript'
import { MATCHER_SOURCE, SUPPORTED_MATCHER_GIT_BLOB_SHA1 } from './constants.mjs'
import { gitBlobSha1, sha256Hex } from './util.mjs'

const HOOK_NAME = '__MOCHI_SHAPE_PATTERN_MEASUREMENT__'

export async function loadMatcherModule({
  instrumented = false,
  expectedMatcherSha256 = null,
  matcherSourcePath = MATCHER_SOURCE,
  generatedRunDir,
  onMeasurement = () => undefined,
}) {
  if (typeof generatedRunDir !== 'string' || !generatedRunDir) throw new TypeError('generatedRunDir is required')
  const sourceVerificationStartedAt = performance.now()
  const sourcePath = resolve(matcherSourcePath)
  const source = await readFile(sourcePath, 'utf8')
  const sourceSha256 = sha256Hex(source)
  const sourceGitBlobSha1 = gitBlobSha1(source)
  if (sourceGitBlobSha1 !== SUPPORTED_MATCHER_GIT_BLOB_SHA1) {
    throw unsupportedRevision(`matcher Git blob ${sourceGitBlobSha1} is not supported`)
  }
  if (instrumented) {
    if (!expectedMatcherSha256) throw unsupportedRevision('instrumented mode requires an expected matcher SHA-256')
    if (sourceSha256 !== expectedMatcherSha256.toLowerCase()) {
      throw unsupportedRevision(`matcher SHA-256 mismatch: expected ${expectedMatcherSha256}, got ${sourceSha256}`)
    }
  }
  const sourceVerificationTimeMs = performance.now() - sourceVerificationStartedAt

  const generatedSource = instrumented ? instrumentSource(source) : source
  const transpileStartedAt = performance.now()
  const compiled = ts.transpileModule(generatedSource, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      sourceMap: false,
      inlineSourceMap: false,
      removeComments: false,
    },
    fileName: matcherSourcePath,
    reportDiagnostics: true,
  })
  const errors = (compiled.diagnostics ?? []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
  if (errors.length) throw new Error(`Matcher transpilation failed: ${errors.map(formatDiagnostic).join('; ')}`)
  const transpileTimeMs = performance.now() - transpileStartedAt

  await mkdir(generatedRunDir, { recursive: true })
  const outputPath = resolve(generatedRunDir, `shape-pattern-matcher-${instrumented ? 'instrumented' : 'plain'}-${randomUUID()}.mjs`)
  await writeFile(outputPath, compiled.outputText, { flag: 'wx', mode: 0o600 })

  let module
  const importStartedAt = performance.now()
  try {
    module = await import(`${pathToFileURL(outputPath).href}?run=${randomUUID()}`)
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined)
    throw error
  }
  const importTimeMs = performance.now() - importStartedAt
  if (typeof module.matchShapesToPatterns !== 'function') {
    await rm(outputPath, { force: true })
    throw new TypeError('Compiled matcher does not export matchShapesToPatterns')
  }

  let firstCollectorError = null
  let disposed = false
  const invoke = (patterns, shapes, options = {}) => {
    if (disposed) throw new Error('Matcher module has been disposed')
    const previousHook = globalThis[HOOK_NAME]
    if (instrumented) {
      globalThis[HOOK_NAME] = (event, payload) => {
        try { onMeasurement(event, payload) } catch (error) { firstCollectorError ??= error }
      }
    }
    try {
      return module.matchShapesToPatterns(patterns, shapes, options)
    } finally {
      if (instrumented) {
        if (previousHook === undefined) delete globalThis[HOOK_NAME]
        else globalThis[HOOK_NAME] = previousHook
      }
    }
  }
  const dispose = async () => {
    if (disposed) return
    disposed = true
    await rm(outputPath, { force: true })
  }
  return {
    invoke,
    dispose,
    takeCollectorError: () => firstCollectorError,
    sourceSha256,
    sourceGitBlobSha1,
    loaderTimings: { sourceVerificationTimeMs, transpileTimeMs, importTimeMs },
    outputPath,
  }
}

export async function executeMatcher(options) {
  const loaded = await loadMatcherModule({
    instrumented: options.instrumented,
    expectedMatcherSha256: options.expectedMatcherSha256,
    matcherSourcePath: options.matcherSourcePath,
    generatedRunDir: options.generatedRunDir ?? options.generatedDir,
    onMeasurement: options.onMeasurement,
  })
  let result
  try {
    result = loaded.invoke(options.patterns, options.shapes, options.options)
  } finally {
    await loaded.dispose()
  }
  const collectorError = loaded.takeCollectorError()
  if (collectorError) throw collectorFailure(collectorError)
  return {
    result,
    sourceSha256: loaded.sourceSha256,
    sourceGitBlobSha1: loaded.sourceGitBlobSha1,
    loaderTimings: loaded.loaderTimings,
  }
}

export function instrumentSource(source) {
  let next = source
  next = replaceExactlyOnce(next,
    'export function matchShapesToPatterns(\n',
    `${observerPrelude()}\nexport function matchShapesToPatterns(\n`,
    'top-level observer helpers')

  next = replaceExactlyOnce(next,
    `    if (duplicateShapeIds.has(shape.shapeId)) {\n      rejectedContexts.push(context)`,
    `    if (duplicateShapeIds.has(shape.shapeId)) {\n      __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: Array.isArray(shape.coordinates) ? shape.coordinates.length : 0, normalizedCoordinateCount: null, segmentCount: null, closureClassification: shape.direction === 2 ? 'open-or-invalid' : 'not-direction-2', closureGapDistanceMeters: null, accepted: false })\n      rejectedContexts.push(context)`,
    'duplicate Shape classification')

  next = replaceExactlyOnce(next,
    `    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {\n      rejectedContexts.push(context)`,
    `    if (!shape.shapeId || !shape.routeUid || normalizedCoordinates === null) {\n      __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: Array.isArray(shape.coordinates) ? shape.coordinates.length : 0, normalizedCoordinateCount: null, segmentCount: null, closureClassification: shape.direction === 2 ? 'open-or-invalid' : 'not-direction-2', closureGapDistanceMeters: null, accepted: false })\n      rejectedContexts.push(context)`,
    'invalid Shape classification')

  next = replaceExactlyOnce(next,
    `      if (closure.kind === 'open') {\n        rejectedContexts.push(context)`,
    `      if (closure.kind === 'open') {\n        __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: normalizedCoordinates.length, segmentCount: buildSegments(normalizedCoordinates).length, closureClassification: 'open-or-invalid', closureGapDistanceMeters: closure.gapDistanceMeters, accepted: false })\n        rejectedContexts.push(context)`,
    'open Direction 2 classification')

  next = replaceExactlyOnce(next,
    `    validShapes.push({\n      ...shape,`,
    `    __measure('shape-classified', { shapeId: shape.shapeId, direction: shape.direction, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: normalizedCoordinates.length, segmentCount: buildSegments(normalizedCoordinates).length, closureClassification: shape.direction === 2 ? direction2ClosureKind : 'not-direction-2', closureGapDistanceMeters, accepted: true })\n    validShapes.push({\n      ...shape,`,
    'accepted Shape classification')

  next = replaceExactlyOnce(next,
    `      const geometry = scoreGeometry(pattern, shape, options)\n      if (!geometry) continue\n      pairs.push({ pattern, shape, ...geometry })`,
    `      const __pairContext = { patternId: pattern.patternId, shapeId: shape.shapeId, stopCount: pattern.normalizedStops.length, rawCoordinateCount: shape.coordinates.length, normalizedCoordinateCount: shape.normalizedCoordinates.length, segmentCount: buildSegments(shape.normalizedCoordinates).length, closureClassification: shape.direction === 2 ? shape.direction2ClosureKind : 'not-direction-2', closureGapDistanceMeters: shape.closureGapDistanceMeters }\n      __measurementPair = __pairContext\n      __measure('pair-start', __pairContext)\n      const __pairStartedAt = performance.now()\n      let geometry: Pick<ScoredPair, 'costMeters' | 'metrics'> | null\n      try { geometry = scoreGeometry(pattern, shape, options) }\n      catch (error) { __measure('pair-end', { ...__pairContext, status: 'throw', compatible: null, elapsedMs: performance.now() - __pairStartedAt }); __measurementPair = null; throw error }\n      __measure('pair-end', { ...__pairContext, status: geometry ? 'compatible' : 'incompatible', compatible: geometry !== null, elapsedMs: performance.now() - __pairStartedAt })\n      __measurementPair = null\n      if (!geometry) continue\n      pairs.push({ pattern, shape, ...geometry })`,
    'pair scoring observer')

  next = replaceExactlyOnce(next,
    `  const forward = scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  )\n  const reverse = scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  )`,
    `  const forward = __measureOrientation('forward', () => scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  ))\n  const reverse = __measureOrientation('reverse', () => scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  ))`,
    'orientation observer')

  next = replaceEveryRequired(next,
    `matchOrderedStopsToPolyline(pattern.normalizedStops, unwrapped, {`,
    `__measureProjection(pattern.normalizedStops, unwrapped, {`,
    2,
    'Direction 2 projection calls')
  next = replaceEveryRequired(next,
    `matchOrderedStopsToPolyline(pattern.normalizedStops, orientedCoordinates, {`,
    `__measureProjection(pattern.normalizedStops, orientedCoordinates, {`,
    1,
    'linear projection call')

  next = replaceExactlyOnce(next,
    `    if (current.every((frontier) => frontier.length === 0)) return null\n    previous = current`,
    `    __measure('projection-layer', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, layer: stopIndex, frontierWidth: current.reduce((maximum, frontier) => Math.max(maximum, frontier.length), 0), retainedNodes: current.reduce((sum, frontier) => sum + frontier.length, 0), parentNodeCount: current.flat().filter((node) => node.parent !== null).length, pathKeyChars: current.flat().reduce((sum, node) => sum + node.pathKey.length, 0) })\n    if (current.every((frontier) => frontier.length === 0)) return null\n    previous = current`,
    'projection layer observer')

  next = replaceExactlyOnce(next,
    `  const best = solveAssignment(matrix)`,
    `  const best = __measureAssignment('best', () => solveAssignment(matrix))`,
    'best assignment observer')
  next = replaceExactlyOnce(next,
    `      const solution = solveWithForcedMatch(matrix, patternIndex, shapeIndex)`,
    `      const solution = __measureAssignment('forced-match', () => solveWithForcedMatch(matrix, patternIndex, shapeIndex))`,
    'forced match observer')
  next = replaceExactlyOnce(next,
    `    const unmatchedSolution = solveWithForcedUnmatched(matrix, patternIndex)`,
    `    const unmatchedSolution = __measureAssignment('forced-unmatched', () => solveWithForcedUnmatched(matrix, patternIndex))`,
    'forced unmatched observer')
  next = replaceExactlyOnce(next,
    `    states = next\n  }`,
    `    states = next\n    __measure('assignment-state', { kind: __measurementAssignmentKind, activeMaskCount: states.size })\n  }`,
    'assignment state observer')
  return next
}

function observerPrelude() {
  return `let __measurementPair: Record<string, unknown> | null = null
let __measurementOrientation: 'forward' | 'reverse' | null = null
let __measurementAssignmentKind: string | null = null
const __measure = (event: string, payload: Record<string, unknown> = {}): void => {
  try { const hook = globalThis.${HOOK_NAME}; if (typeof hook === 'function') hook(event, payload) } catch {}
}
const __measureOrientation = <T>(orientation: 'forward' | 'reverse', run: () => T): T => {
  const startedAt = performance.now()
  const previous = __measurementOrientation
  __measurementOrientation = orientation
  let status = 'throw'
  try { const value = run(); status = value === null ? 'no-path' : 'success'; return value }
  finally { __measure('orientation-end', { ...(__measurementPair ?? {}), orientation, status, elapsedMs: performance.now() - startedAt }); __measurementOrientation = previous }
}
const __measureProjection = <T>(stops: ShapePatternStop[], coordinates: ShapePosition[], options: { objective: ProjectionObjective; maxSpanMeters: number | null; maxMeanStopDistanceMeters: number; maxStopDistanceMeters: number }): T => {
  const startedAt = performance.now()
  const segmentCount = buildSegments(coordinates).length
  __measure('projection-start', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, stopCount: stops.length, segmentCount, candidateCount: stops.length * segmentCount })
  let status = 'throw'
  try { const value = matchOrderedStopsToPolyline(stops, coordinates, options) as T; status = value === null ? 'no-path' : 'success'; return value }
  finally { __measure('projection-end', { ...(__measurementPair ?? {}), orientation: __measurementOrientation, objective: options.objective, status, elapsedMs: performance.now() - startedAt }) }
}
const __measureAssignment = <T>(kind: string, run: () => T): T => {
  const startedAt = performance.now()
  const previous = __measurementAssignmentKind
  __measurementAssignmentKind = kind
  __measure('assignment-solve-start', { kind })
  let status = 'throw'
  try { const value = run(); status = 'success'; return value }
  finally { __measure('assignment-solve-end', { kind, status, elapsedMs: performance.now() - startedAt }); __measurementAssignmentKind = previous }
}`
}

function replaceExactlyOnce(source, anchor, replacement, label) {
  const count = source.split(anchor).length - 1
  if (count !== 1) throw unsupportedRevision(`${label} anchor mismatch: expected 1, found ${count}`)
  return source.replace(anchor, replacement)
}
function replaceEveryRequired(source, anchor, replacement, expectedCount, label) {
  const count = source.split(anchor).length - 1
  if (count !== expectedCount) throw unsupportedRevision(`${label} anchor mismatch: expected ${expectedCount}, found ${count}`)
  return source.split(anchor).join(replacement)
}
function unsupportedRevision(message) { const error = new Error(`Unsupported matcher revision: ${message}`); error.code = 'UNSUPPORTED_MATCHER_REVISION'; return error }
export function collectorFailure(error) { const wrapped = new Error('Measurement collector failed', { cause: error }); wrapped.code = 'MEASUREMENT_COLLECTOR_ERROR'; return wrapped }
function formatDiagnostic(diagnostic) { return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n') }
