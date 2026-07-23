import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { MATCHER_SOURCE, RAW_SCHEMA_VERSION } from './constants.mjs'
import { createMeasurementReport } from './report.mjs'
import { validateReport } from './report-schema.mjs'
import { contentHash, sha256Hex } from './util.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function rawManifest(bundle) {
  const source = bundle.sources[0]
  const endpoints = [
    {
      endpointId: 'city-Taipei-shape', scope: 'city', city: 'Taipei', category: 'shape',
      fileName: 'city-Taipei-shape.json', contentHash: contentHash(source.shapes),
      itemCount: source.shapes.length, maxUpdateTime: null,
    },
    {
      endpointId: 'city-Taipei-stop-of-route', scope: 'city', city: 'Taipei', category: 'stop-of-route',
      fileName: 'city-Taipei-stop-of-route.json', contentHash: contentHash(source.stopOfRoute),
      itemCount: source.stopOfRoute.length, maxUpdateTime: null,
    },
  ]
  return {
    schemaVersion: RAW_SCHEMA_VERSION,
    fetchedAt: '2026-07-22T00:00:00.000Z',
    cities: ['Taipei'],
    includeIntercity: false,
    endpoints,
    bundleContentHash: contentHash({
      schemaVersion: RAW_SCHEMA_VERSION,
      cities: ['Taipei'],
      includeIntercity: false,
      endpoints,
    }),
  }
}

async function makeReport(candidateBundle, manifest, generatedRunDir, instrumented, matcherSha256) {
  return createMeasurementReport({
    candidateBundle,
    rawManifest: manifest,
    options: {
      instrumented,
      expectedMatcherSha256: instrumented ? matcherSha256 : null,
      generatedRunDir,
      warmup: 0,
      iterations: 1,
      topOutliers: 5,
    },
    repositoryMainSha: '1'.repeat(40),
  })
}

describe('sanitized offline replay', () => {
  it('executes uninstrumented and instrumented reports against the same verified fixture', async () => {
    const bundle = JSON.parse(await readFile(
      'scripts/shape-pattern-measurement/fixtures/sanitized-raw-bundle.json',
      'utf8',
    ))
    const candidateBundle = buildCandidatePartitions(bundle)
    expect(candidateBundle.partitions.length).toBeGreaterThan(0)
    expect(candidateBundle.rejected).toEqual([])

    const root = await mkdtemp(join(tmpdir(), 'shape-measure-sanitized-replay-'))
    roots.push(root)
    const matcherSha256 = sha256Hex(await readFile(MATCHER_SOURCE))
    const manifest = rawManifest(bundle)

    const plain = await makeReport(candidateBundle, manifest, join(root, 'plain'), false, matcherSha256)
    const instrumented = await makeReport(candidateBundle, manifest, join(root, 'instrumented'), true, matcherSha256)

    expect(() => validateReport(plain)).not.toThrow()
    expect(() => validateReport(instrumented)).not.toThrow()
    expect(plain.metadata.mode).toBe('uninstrumented')
    expect(plain.metadata.pairMetricsAvailable).toBe(false)
    expect(plain.pairs).toEqual([])
    expect(instrumented.metadata.mode).toBe('instrumented')
    expect(instrumented.metadata.pairMetricsAvailable).toBe(true)
    expect(instrumented.pairs.length).toBeGreaterThan(0)
    expect(instrumented.metadata.matcherSourceSha256).toBe(plain.metadata.matcherSourceSha256)
    expect(instrumented.metadata.matcherSourceGitBlobSha1).toBe(plain.metadata.matcherSourceGitBlobSha1)
    expect(instrumented.metadata.provenance.bundleContentHash).toBe(plain.metadata.provenance.bundleContentHash)
  })
})
