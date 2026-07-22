import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { MATCHER_SOURCE, SUPPORTED_MATCHER_GIT_BLOB_SHA1 } from './constants.mjs'
import { gitBlobSha1, sha256Hex } from './util.mjs'

const HOOK_NAME = '__MOCHI_SHAPE_PATTERN_MEASUREMENT__'

export async function executeMatcher({
  patterns,
  shapes,
  options = {},
  instrumented = false,
  expectedMatcherSha256 = null,
  matcherSourcePath = MATCHER_SOURCE,
  generatedDir,
  onMeasurement = () => undefined,
}) {
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

  const generatedSource = instrumented ? instrumentSource(source) : source
  const outputPath = resolve(generatedDir, `shape-pattern-matcher.${sourceSha256.slice(0, 16)}.${instrumented ? 'instrumented' : 'plain'}.${process.pid}.mjs`)
  await mkdir(dirname(outputPath), { recursive: true })
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
  await writeFile(outputPath, compiled.outputText)

  const previousHook = globalThis[HOOK_NAME]
  globalThis[HOOK_NAME] = (event, payload) => {
    try { onMeasurement(event, payload) } catch { /* instrumentation cannot affect matcher control flow */ }
  }
  try {
    const moduleUrl = `${pathToFileURL(outputPath).href}?revision=${sourceSha256}&nonce=${Date.now()}`
    const matcher = await import(moduleUrl)
    const result = matcher.matchShapesToPatterns(patterns, shapes, options)
    return { result, sourceSha256, sourceGitBlobSha1 }
  } finally {
    if (previousHook === undefined) delete globalThis[HOOK_NAME]
    else globalThis[HOOK_NAME] = previousHook
    await rm(outputPath, { force: true })
  }
}

export function instrumentSource(source) {
  let next = source
  next = replaceExactlyOnce(next,
    'export function matchShapesToPatterns(\n',
    `const __measurementHook = globalThis.${HOOK_NAME}\n` +
    `const __measure = (event: string, payload: Record<string, unknown> = {}): void => {\n` +
    `  try { if (typeof __measurementHook === 'function') __measurementHook(event, payload) } catch {}\n` +
    `}\n\nexport function matchShapesToPatterns(\n`,
    'top-level hook')

  next = replaceExactlyOnce(next,
    `      const geometry = scoreGeometry(pattern, shape, options)\n      if (!geometry) continue\n      pairs.push({ pattern, shape, ...geometry })`,
    `      const __pairStartedAt = performance.now()\n` +
    `      __measure('pair-start', { patternId: pattern.patternId, shapeId: shape.shapeId })\n` +
    `      const geometry = scoreGeometry(pattern, shape, options)\n` +
    `      __measure('pair-end', { patternId: pattern.patternId, shapeId: shape.shapeId, compatible: geometry !== null, elapsedMs: performance.now() - __pairStartedAt })\n` +
    `      if (!geometry) continue\n` +
    `      pairs.push({ pattern, shape, ...geometry })`,
    'pair scoring')

  next = replaceExactlyOnce(next,
    `  const forward = scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  )\n  const reverse = scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  )`,
    `  const __forwardStartedAt = performance.now()\n` +
    `  const forward = scoreOrientation(\n    pattern,\n    shape.normalizedCoordinates,\n    options,\n    shape.closureGapDistanceMeters,\n  )\n` +
    `  __measure('orientation-end', { orientation: 'forward', elapsedMs: performance.now() - __forwardStartedAt })\n` +
    `  const __reverseStartedAt = performance.now()\n` +
    `  const reverse = scoreOrientation(\n    pattern,\n    [...shape.normalizedCoordinates].reverse(),\n    options,\n    shape.closureGapDistanceMeters,\n  )\n` +
    `  __measure('orientation-end', { orientation: 'reverse', elapsedMs: performance.now() - __reverseStartedAt })`,
    'orientation timings')

  next = replaceExactlyOnce(next,
    `  const segments = buildSegments(coordinates)\n  if (!stops.length || !segments.length) return null\n  const projections = stops.map((stop) => segments.map((segment) => projectStopToSegment(stop.coordinate, segment)))\n  const spanConstrained = options.maxSpanMeters !== null\n  let previous = projections[0].map((projection) => [initialProjectionNode(projection)])`,
    `  const __projectionStartedAt = performance.now()\n` +
    `  const segments = buildSegments(coordinates)\n` +
    `  if (!stops.length || !segments.length) return null\n` +
    `  const projections = stops.map((stop) => segments.map((segment) => projectStopToSegment(stop.coordinate, segment)))\n` +
    `  __measure('projection-start', { objective: options.objective, stopCount: stops.length, segmentCount: segments.length, candidateCount: stops.length * segments.length })\n` +
    `  const spanConstrained = options.maxSpanMeters !== null\n` +
    `  let previous = projections[0].map((projection) => [initialProjectionNode(projection)])\n` +
    `  __measure('projection-layer', { objective: options.objective, layer: 0, frontierWidth: previous.reduce((sum, frontier) => sum + frontier.length, 0), retainedNodes: previous.reduce((sum, frontier) => sum + frontier.length, 0), parentNodeCount: 0, pathKeyChars: previous.flat().reduce((sum, node) => sum + node.pathKey.length, 0) })`,
    'projection start')

  next = replaceExactlyOnce(next,
    `    if (current.every((frontier) => frontier.length === 0)) return null\n    previous = current`,
    `    if (current.every((frontier) => frontier.length === 0)) return null\n` +
    `    __measure('projection-layer', { objective: options.objective, layer: stopIndex, frontierWidth: current.reduce((sum, frontier) => sum + frontier.length, 0), retainedNodes: current.reduce((sum, frontier) => sum + frontier.length, 0), parentNodeCount: current.flat().filter((node) => node.parent !== null).length, pathKeyChars: current.flat().reduce((sum, node) => sum + node.pathKey.length, 0) })\n` +
    `    previous = current`,
    'projection layer')

  next = replaceExactlyOnce(next,
    `  return {\n    projections: selected,\n    distanceSumMeters: best.distanceSumMeters,\n    maxDistanceMeters: best.maxDistanceMeters,\n  }`,
    `  __measure('projection-end', { objective: options.objective, elapsedMs: performance.now() - __projectionStartedAt })\n` +
    `  return {\n    projections: selected,\n    distanceSumMeters: best.distanceSumMeters,\n    maxDistanceMeters: best.maxDistanceMeters,\n  }`,
    'projection end')

  next = replaceExactlyOnce(next,
    `  const best = solveAssignment(matrix)\n  const matches: ShapePatternMatch[] = []`,
    `  const __bestStartedAt = performance.now()\n` +
    `  __measure('assignment-solve-start', { kind: 'best' })\n` +
    `  const best = solveAssignment(matrix)\n` +
    `  __measure('assignment-solve-end', { kind: 'best', elapsedMs: performance.now() - __bestStartedAt })\n` +
    `  const matches: ShapePatternMatch[] = []`,
    'best assignment')

  next = replaceExactlyOnce(next,
    `      const solution = solveWithForcedMatch(matrix, patternIndex, shapeIndex)`,
    `      const __forcedMatchStartedAt = performance.now()\n` +
    `      __measure('assignment-solve-start', { kind: 'forced-match' })\n` +
    `      const solution = solveWithForcedMatch(matrix, patternIndex, shapeIndex)\n` +
    `      __measure('assignment-solve-end', { kind: 'forced-match', elapsedMs: performance.now() - __forcedMatchStartedAt })`,
    'forced match')

  next = replaceExactlyOnce(next,
    `    const unmatchedSolution = solveWithForcedUnmatched(matrix, patternIndex)`,
    `    const __forcedUnmatchedStartedAt = performance.now()\n` +
    `    __measure('assignment-solve-start', { kind: 'forced-unmatched' })\n` +
    `    const unmatchedSolution = solveWithForcedUnmatched(matrix, patternIndex)\n` +
    `    __measure('assignment-solve-end', { kind: 'forced-unmatched', elapsedMs: performance.now() - __forcedUnmatchedStartedAt })`,
    'forced unmatched')

  next = replaceExactlyOnce(next,
    `    states = next\n  }\n\n  let best = emptyAssignment()`,
    `    states = next\n` +
    `    __measure('assignment-state', { stateCount: states.size, activeMaskCount: states.size, bitCount: bitIndices.length })\n` +
    `  }\n\n  let best = emptyAssignment()`,
    'assignment states')
  return next
}

function replaceExactlyOnce(source, anchor, replacement, label) {
  const first = source.indexOf(anchor)
  if (first < 0 || source.indexOf(anchor, first + anchor.length) >= 0) {
    throw unsupportedRevision(`instrumentation anchor mismatch: ${label}`)
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + anchor.length)}`
}

function unsupportedRevision(message) {
  const error = new Error(`Unsupported matcher revision: ${message}`)
  error.code = 'UNSUPPORTED_MATCHER_REVISION'
  return error
}

function formatDiagnostic(diagnostic) {
  return ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
}
