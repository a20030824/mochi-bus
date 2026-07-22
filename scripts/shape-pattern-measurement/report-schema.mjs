import { assertFiniteTree, stableStringify } from './util.mjs'

export const REPORT_FILES = [
  'metadata.json', 'partitions.jsonl', 'pairs.jsonl', 'outcomes.json', 'outliers.json', 'summary.json',
]

export function validateReport(report) {
  for (const key of ['metadata', 'partitions', 'pairs', 'outcomes', 'outliers', 'summary']) {
    if (!(key in report)) throw new TypeError(`report.${key} is required`)
  }
  if (!Array.isArray(report.partitions) || !Array.isArray(report.pairs)) throw new TypeError('report JSONL collections must be arrays')
  assertFiniteTree(report)
  for (const partition of report.partitions) {
    for (const key of ['partitionId', 'sourceScope', 'routeUid', 'direction', 'patternCount', 'shapeCount']) {
      if (!(key in partition)) throw new TypeError(`partition.${key} is required`)
    }
  }
  for (const pair of report.pairs) {
    for (const key of ['partitionId', 'patternId', 'shapeId', 'stopCount', 'rawCoordinateCount']) {
      if (!(key in pair)) throw new TypeError(`pair.${key} is required`)
    }
  }
  validateDistributionTree(report.summary)
  return report
}

export function validateDistributionTree(summary) {
  for (const [name, value] of Object.entries(summary)) {
    if (!value || typeof value !== 'object') throw new TypeError(`summary.${name} must be an object`)
    const ordered = ['min', 'median', 'p75', 'p90', 'p95', 'p99', 'max']
      .map((key) => value[key]).filter((entry) => entry !== null)
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index] < ordered[index - 1]) throw new TypeError(`summary.${name} percentiles are not ordered`)
    }
    if (!Number.isInteger(value.count) || value.count < 0) throw new TypeError(`summary.${name}.count must be non-negative`)
  }
}

export function toJsonLines(records) {
  return records.map((record) => stableStringify(record)).join('\n') + (records.length ? '\n' : '')
}

export function parseJsonLines(source) {
  if (!source.trim()) return []
  return source.trimEnd().split('\n').map((line) => JSON.parse(line))
}
