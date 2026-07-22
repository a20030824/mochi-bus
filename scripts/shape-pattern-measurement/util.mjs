import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'

export const sha256Hex = (value) => createHash('sha256').update(value).digest('hex')

export function gitBlobSha1(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value)
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex')
}

export function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
  }
  return value
}

export const stableStringify = (value, space = 0) => JSON.stringify(stableValue(value), null, space)
export const contentHash = (value) => sha256Hex(stableStringify(value))

export async function atomicWrite(file, content) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(content)
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

export async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'))
}

export async function writeJson(file, value) {
  await atomicWrite(file, `${stableStringify(value, 2)}\n`)
}

export function finiteNonNegative(value, name) {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be a finite non-negative number`)
  return value
}

export function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive safe integer`)
  return value
}

export function sanitizePathFragment(value) {
  return String(value).replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 120)
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
}

export function percentile(values, percentileValue) {
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new RangeError('percentile must be within [0, 1]')
  }
  const sorted = values.filter((value) => Number.isFinite(value)).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  if (percentileValue === 0) return sorted[0]
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)
  return sorted[index]
}

export function distribution(values) {
  const finite = values.filter((value) => Number.isFinite(value))
  return {
    count: finite.length,
    min: percentile(finite, 0),
    median: percentile(finite, 0.5),
    p75: percentile(finite, 0.75),
    p90: percentile(finite, 0.9),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
    max: percentile(finite, 1),
  }
}

export function median(values) {
  return percentile(values, 0.5)
}

export function pathContains(ancestor, candidate) {
  const rel = relative(resolve(ancestor), resolve(candidate))
  return rel === '' || (!rel.startsWith('..') && !rel.includes(`..${process.platform === 'win32' ? '\\' : '/'}`) && !resolve(candidate).startsWith(`${resolve(ancestor)}..`))
}

export function assertStrictChild(parent, child, label = 'path') {
  if (!pathContains(parent, child) || resolve(parent) === resolve(child)) {
    throw new Error(`${label} must be a strict child of its owned root`)
  }
}

export function assertFiniteTree(value, path = '$') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${path} must be finite`)
  if (Array.isArray(value)) value.forEach((child, index) => assertFiniteTree(child, `${path}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertFiniteTree(child, `${path}.${key}`)
  }
}

const NONDETERMINISTIC_KEYS = new Set([
  'runId', 'deterministicContentHash', 'startedAt', 'completedAt', 'publishedAt', 'timestamp', 'fetchedAt',
  'elapsedMs', 'matcherLatencyMs', 'matcherIterationSamplesMs', 'iterationLatencyMs', 'pairTimeMs', 'forwardTimeMs', 'reverseTimeMs',
  'costObjectiveSolveTimeMs', 'spanObjectiveSolveTimeMs', 'bestAssignmentTimeMs',
  'ambiguityProofTimeMs', 'sourceVerificationTimeMs', 'transpileTimeMs', 'importTimeMs',
  'rssBeforeBytes', 'rssAfterBytes', 'rssDeltaBytes', 'heapBeforeBytes', 'heapAfterBytes',
  'heapDeltaBytes', 'memoryObservation',
])

export function omitNondeterministic(value) {
  if (Array.isArray(value)) return value.map(omitNondeterministic)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !NONDETERMINISTIC_KEYS.has(key))
    .map(([key, child]) => [key, omitNondeterministic(child)]))
}
