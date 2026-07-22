import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

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
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, content)
  await rename(temporary, file)
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
  if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`)
  return value
}

export function optionalBoolean(value) {
  return value === true
}

export function sanitizePathFragment(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120)
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function percentile(values, percentileValue) {
  if (!Number.isFinite(percentileValue) || percentileValue < 0 || percentileValue > 1) {
    throw new RangeError('percentile must be within [0, 1]')
  }
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  if (percentileValue === 0) return sorted[0]
  const index = Math.min(sorted.length - 1, Math.ceil(percentileValue * sorted.length) - 1)
  return sorted[index]
}

export function distribution(values) {
  const finite = values.filter(Number.isFinite)
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

export function omitNondeterministic(value) {
  if (Array.isArray(value)) return value.map(omitNondeterministic)
  if (!value || typeof value !== 'object') return value
  const omitted = new Set([
    'startedAt', 'completedAt', 'fetchedAt', 'timestamp', 'wallTimeMs', 'partitionWallTimeMs',
    'pairTimeMs', 'forwardTimeMs', 'reverseTimeMs', 'assignmentTimeMs', 'ambiguityProofTimeMs',
    'bestAssignmentTimeMs', 'bestTimeMs', 'forcedMatchTimeMs', 'forcedUnmatchedTimeMs',
    'costObjectiveSolveTimeMs', 'spanObjectiveSolveTimeMs',
    'rssBytes', 'heapUsedBytes', 'peakRssBytes', 'peakHeapUsedBytes',
  ])
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !omitted.has(key))
    .map(([key, child]) => [key, omitNondeterministic(child)]))
}

export function assertFiniteTree(value, path = '$') {
  if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${path} must be finite`)
  if (Array.isArray(value)) value.forEach((child, index) => assertFiniteTree(child, `${path}[${index}]`))
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) assertFiniteTree(child, `${path}.${key}`)
  }
}
