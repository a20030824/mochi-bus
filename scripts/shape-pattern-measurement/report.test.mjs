import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { createMeasurementReport, writeMeasurementReport } from './report.mjs'
import { parseJsonLines } from './report-schema.mjs'
import { omitNondeterministic, stableStringify } from './util.mjs'

const fixture = JSON.parse(await readFile(new URL('./fixtures/sanitized-raw-bundle.json', import.meta.url), 'utf8'))
const rawManifest = {
  schemaVersion: 1,
  fetchedAt: fixture.fetchedAt,
  cities: ['Taipei'],
  includeIntercity: true,
  endpoints: [
    { category: 'stop-of-route', city: 'Taipei', scope: 'city', contentHash: 'a'.repeat(64) },
    { category: 'shape', city: 'Taipei', scope: 'city', contentHash: 'b'.repeat(64) },
    { category: 'stop-of-route-intercity', city: null, scope: 'intercity', contentHash: 'c'.repeat(64) },
    { category: 'shape-intercity', city: null, scope: 'intercity', contentHash: 'd'.repeat(64) },
  ],
}

describe('measurement report generation', () => {
  it('writes all required files and stable JSONL records', async () => {
    const root = await mkdtemp(join(tmpdir(), 'measurement-report-'))
    const options = {
      cities: ['Taipei'], includeIntercity: true, instrumented: false,
      expectedMatcherSha256: null, warmup: 0, iterations: 1, topOutliers: 3,
      generatedDir: join(root, 'generated'),
    }
    try {
      const report = await createMeasurementReport({
        candidateBundle: buildCandidatePartitions(fixture), rawManifest, options,
        repositoryMainSha: '1'.repeat(40),
      })
      await writeMeasurementReport(report, join(root, 'reports'))
      expect((await readdir(join(root, 'reports'))).sort()).toEqual([
        'metadata.json', 'outcomes.json', 'outliers.json', 'pairs.jsonl', 'partitions.jsonl', 'summary.json',
      ])
      expect(parseJsonLines(await readFile(join(root, 'reports', 'partitions.jsonl'), 'utf8'))).toEqual(report.partitions)
      expect(report.pairs.length).toBeGreaterThan(0)
      expect(report.metadata.matcherSourceSha256).toMatch(/^[a-f0-9]{64}$/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('keeps non-timing report content deterministic', async () => {
    const root = await mkdtemp(join(tmpdir(), 'measurement-determinism-'))
    const options = {
      cities: ['Taipei'], includeIntercity: true, instrumented: false,
      expectedMatcherSha256: null, warmup: 0, iterations: 1, topOutliers: 3,
      generatedDir: join(root, 'generated'),
    }
    try {
      const first = await createMeasurementReport({ candidateBundle: buildCandidatePartitions(fixture), rawManifest, options, repositoryMainSha: '1'.repeat(40) })
      const second = await createMeasurementReport({ candidateBundle: buildCandidatePartitions(fixture), rawManifest, options, repositoryMainSha: '1'.repeat(40) })
      expect(first.metadata.deterministicContentHash).toBe(second.metadata.deterministicContentHash)
      expect(stableStringify(omitNondeterministic(first.partitions))).toBe(stableStringify(omitNondeterministic(second.partitions)))
      expect(stableStringify(omitNondeterministic(first.pairs))).toBe(stableStringify(omitNondeterministic(second.pairs)))
      expect(first.outcomes).toEqual(second.outcomes)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
