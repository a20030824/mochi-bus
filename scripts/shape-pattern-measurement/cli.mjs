import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import {
  ALL_CITIES, DEFAULT_CITIES, DEFAULT_FETCH_CONCURRENCY, DEFAULT_GENERATED_DIR,
  DEFAULT_RAW_DIR, DEFAULT_REPORT_DIR, DEFAULT_TOP_OUTLIERS,
} from './constants.mjs'
import { finiteNonNegative, positiveInteger } from './util.mjs'

const SECRET_FLAGS = new Set(['--client-id', '--client-secret', '--token'])
const VALUE_FLAGS = new Set([
  '--cities', '--raw-dir', '--report-dir', '--generated-dir', '--warmup', '--iterations',
  '--top-outliers', '--fetch-concurrency', '--expected-matcher-sha256',
])
const BOOLEAN_FLAGS = new Set(['--include-intercity', '--replay', '--instrumented', '--help'])

export async function parseCli(argv, { requireReplayPath = true } = {}) {
  const values = new Map()
  const booleans = new Set()
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (SECRET_FLAGS.has(token)) throw new Error(`${token} is forbidden; credentials are read only from environment or .dev.vars`)
    if (BOOLEAN_FLAGS.has(token)) {
      booleans.add(token)
      continue
    }
    if (!VALUE_FLAGS.has(token)) throw new Error(`Unknown option: ${token}`)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${token} requires a value`)
    values.set(token, value)
    index += 1
  }

  const cities = (values.get('--cities') ?? DEFAULT_CITIES.join(','))
    .split(',').map((value) => value.trim()).filter(Boolean)
  if (!cities.length) throw new Error('--cities must select at least one city')
  const unknown = cities.filter((city) => !ALL_CITIES.has(city))
  if (unknown.length) throw new Error(`Unknown city: ${unknown.join(', ')}`)

  const rawDir = resolve(values.get('--raw-dir') ?? DEFAULT_RAW_DIR)
  const reportDir = resolve(values.get('--report-dir') ?? DEFAULT_REPORT_DIR)
  const generatedDir = resolve(values.get('--generated-dir') ?? DEFAULT_GENERATED_DIR)
  if (rawDir === reportDir || rawDir === generatedDir || reportDir === generatedDir) {
    throw new Error('raw, report, and generated directories must be distinct')
  }

  const options = {
    help: booleans.has('--help'),
    cities: [...new Set(cities)],
    includeIntercity: booleans.has('--include-intercity'),
    replay: booleans.has('--replay'),
    instrumented: booleans.has('--instrumented'),
    rawDir,
    reportDir,
    generatedDir,
    warmup: parseCount(values.get('--warmup') ?? '1', '--warmup', true),
    iterations: parseCount(values.get('--iterations') ?? '1', '--iterations', false),
    topOutliers: parseCount(values.get('--top-outliers') ?? String(DEFAULT_TOP_OUTLIERS), '--top-outliers', false),
    fetchConcurrency: parseCount(values.get('--fetch-concurrency') ?? String(DEFAULT_FETCH_CONCURRENCY), '--fetch-concurrency', false),
    expectedMatcherSha256: values.get('--expected-matcher-sha256') ?? null,
  }
  if (options.expectedMatcherSha256 && !/^[a-f0-9]{64}$/i.test(options.expectedMatcherSha256)) {
    throw new Error('--expected-matcher-sha256 must be a 64-character hexadecimal SHA-256')
  }
  if (options.instrumented && !options.expectedMatcherSha256) {
    throw new Error('--instrumented requires --expected-matcher-sha256 so source revision verification fails closed')
  }
  if (options.replay && requireReplayPath) await access(rawDir)
  return options
}

function parseCount(raw, name, allowZero) {
  const value = Number(raw)
  finiteNonNegative(value, name)
  if (!Number.isInteger(value) || (!allowZero && value === 0)) {
    throw new RangeError(`${name} must be ${allowZero ? 'a non-negative' : 'a positive'} integer`)
  }
  if (!allowZero) positiveInteger(value, name)
  return value
}

export const helpText = `Usage: npm run measure:shape-pattern -- [options]\n\n` +
  `  --cities Taipei,NewTaipei\n  --include-intercity\n  --raw-dir PATH\n  --report-dir PATH\n` +
  `  --replay\n  --instrumented --expected-matcher-sha256 HEX\n  --warmup N\n  --iterations N\n` +
  `  --top-outliers N\n  --fetch-concurrency N\n`
