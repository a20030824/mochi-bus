import { describe, expect, it, vi } from 'vitest'
import {
  artifactHeadMatches,
  classifyProbeRequestFailure,
  createSnapshotProbeDiagnostic,
  deterministicSampleCaseId,
  deterministicSampleIndex,
  networkPrefixMatches,
  probeActiveSnapshot,
  readBoundedResponseJson,
  readBoundedResponseText,
} from './active-probe.mjs'

const city = 'Taipei'
const windowId = 'v1:Taipei:2026-07-20:0317'
const activeVersion = '20260719T192700000Z'
const previousVersion = '20260712T192700000Z'
const counts = { routes: 2, patterns: 2, stops: 4, places: 2, patternStops: 4, placeBundles: 2 }

function fixture(overrides = {}) {
  const sample = {
    pattern_id: 'PATTERN_PRIVATE',
    route_uid: 'ROUTE_PRIVATE',
    route_name: 'ROUTE_NAME_PRIVATE',
    shape_key: `snapshots/${activeVersion}/cities/${city}/shapes/PATTERN_PRIVATE.json`,
    place_id: 'PLACE_PRIVATE',
  }
  const query = vi.fn(async (sql) => {
    if (sql.includes('FROM dataset_versions')) return [{ active_version: activeVersion, imported_at: '2026-07-19T19:27:00.000Z' }]
    if (sql.includes('AS route_without_pattern')) return [{
      routes: counts.routes,
      patterns: counts.patterns,
      stops: counts.stops,
      places: counts.places,
      pattern_stops: counts.patternStops,
      route_without_pattern: 0,
      sample_count: 2,
    }]
    if (sql.includes('SELECT p.pattern_id')) return [sample]
    throw new Error('unexpected query')
  })
  const manifest = {
    schemaVersion: 2,
    city,
    version: activeVersion,
    counts,
    artifacts: [
      { key: `snapshots/${activeVersion}/cities/${city}/network.json`, bytes: 8_000_000 },
      { key: `snapshots/${activeVersion}/cities/${city}/shapes/private.json`, bytes: 512 },
      { key: `snapshots/${activeVersion}/cities/${city}/schedules/private.json`, bytes: 512 },
      { key: `snapshots/${activeVersion}/cities/${city}/places/private.json`, bytes: 512 },
    ],
  }
  const r2 = {
    getManifest: vi.fn(async (key) => key.includes(previousVersion)
      ? {
          ...manifest,
          version: previousVersion,
          artifacts: manifest.artifacts.map((artifact) => ({
            ...artifact,
            key: artifact.key.replace(activeVersion, previousVersion),
          })),
        }
      : manifest),
    head: vi.fn(async (key) => ({ size: key.endsWith('network.json') ? 8_000_000 : 512 })),
    readPrefix: vi.fn(async (key) => {
      const version = key.includes(previousVersion) ? previousVersion : activeVersion
      return `{"schemaVersion":1,"city":"${city}","version":"${version}","routes":[`
    }),
  }
  const publicApi = {
    getJson: vi.fn(async (path) => {
      if (path.includes('/routes?')) return {
        schemaVersion: 2, source: 'snapshot', snapshotVersion: activeVersion,
        routes: [{ routeName: 'A' }, { routeName: 'B' }],
      }
      if (path.includes('/map/route?')) return {
        schemaVersion: 1, source: 'snapshot', snapshotVersion: activeVersion,
        variants: [{
          variantKey: sample.pattern_id,
          routeUid: sample.route_uid,
          stops: { features: [{}, {}] },
        }],
      }
      if (path.includes('/arrivals?')) return {
        schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: activeVersion,
        routes: [{ variantKey: sample.pattern_id, routeUid: sample.route_uid }],
      }
      throw new Error('unexpected public path')
    }),
  }
  return {
    city,
    windowId,
    state: { version: activeVersion, previousVersion },
    query,
    r2,
    publicApi,
    sample,
    diagnosticSink: vi.fn(),
    now: () => new Date('2026-07-19T19:29:00.000Z'),
    ...overrides,
  }
}

describe('active snapshot probe', () => {
  it('requires all hard checks and pins every public read to the active version', async () => {
    const options = fixture()
    const result = await probeActiveSnapshot(options)

    expect(result).toMatchObject({
      activeProbeResult: 'success',
      probeFailureClass: 'none',
      activeVersion,
      previousVersion,
      rollbackAvailable: true,
      hardChecksPassed: 11,
    })
    expect(options.publicApi.getJson).toHaveBeenCalledTimes(3)
    for (const [path] of options.publicApi.getJson.mock.calls) {
      expect(path).toContain(`snapshot=${activeVersion}`)
      expect(path).toContain(`probe=${encodeURIComponent(windowId)}`)
    }
    const routePath = options.publicApi.getJson.mock.calls
      .map(([path]) => path)
      .find((path) => path.includes('/map/route?'))
    expect(routePath).toContain(`routeUid=${encodeURIComponent(options.sample.route_uid)}`)
    expect(routePath).toContain(`patternId=${encodeURIComponent(options.sample.pattern_id)}`)
    expect(options.diagnosticSink).not.toHaveBeenCalled()
  })

  it('accepts missing optional Content-Length but rejects a real mismatch', async () => {
    const accepted = fixture()
    const original = accepted.r2.head
    accepted.r2.head = vi.fn(async (key) => key.endsWith('network.json') && key.includes(activeVersion)
      ? { size: null }
      : original(key))
    await expect(probeActiveSnapshot(accepted)).resolves.toMatchObject({ activeProbeResult: 'success' })

    expect(artifactHeadMatches({ size: null }, { bytes: 100 })).toBe(true)
    expect(artifactHeadMatches({ size: 100 }, { bytes: 100 })).toBe(true)
    expect(artifactHeadMatches({ size: 99 }, { bytes: 100 })).toBe(false)
    expect(artifactHeadMatches({ size: 0 }, { bytes: 100 })).toBe(false)
    expect(artifactHeadMatches(null, { bytes: 100 })).toBe(false)
  })

  it('uses a stable sample for a rerun and rotates across windows', () => {
    expect(deterministicSampleIndex(city, windowId, 1, 101))
      .toBe(deterministicSampleIndex(city, windowId, 1, 101))
    expect(deterministicSampleCaseId(city, windowId, 1))
      .toBe(deterministicSampleCaseId(city, windowId, 1))
    expect(new Set([
      deterministicSampleIndex(city, windowId, 1, 101),
      deterministicSampleIndex(city, 'v1:Taipei:2026-07-27:0317', 1, 101),
      deterministicSampleIndex(city, 'v1:Taipei:2026-08-03:0317', 1, 101),
    ]).size).toBeGreaterThan(1)
  })

  it('uses D1 active as authority when R2 state disagrees', async () => {
    const result = await probeActiveSnapshot(fixture({
      state: { version: 'stale-state-version', previousVersion },
    }))
    expect(result).toMatchObject({
      activeProbeResult: 'degraded',
      activeVersion,
      rollbackAvailable: false,
    })
    expect(result.diagnosticWarnings).toContain('state_pointer_mismatch')
  })

  it('keeps active usable but marks rollback degraded when previous is unavailable', async () => {
    const result = await probeActiveSnapshot(fixture({
      state: { version: activeVersion, previousVersion: null },
    }))
    expect(result).toMatchObject({ activeProbeResult: 'degraded', rollbackAvailable: false })
    expect(result.diagnosticWarnings).toContain('previous_unavailable')
  })

  it.each([
    ['active_pointer_missing', (options) => {
      options.query = vi.fn(async (sql) => sql.includes('FROM dataset_versions') ? [] : [])
    }],
    ['active_pointer_invalid', (options) => {
      const original = options.query
      options.query = vi.fn(async (sql, params) => sql.includes('FROM dataset_versions')
        ? [{ active_version: 'invalid version with spaces' }]
        : original(sql, params))
    }],
    ['active_rows_empty', (options) => {
      const original = options.query
      options.query = vi.fn(async (sql, params) => sql.includes('AS route_without_pattern')
        ? [{ routes: 0, patterns: 0, stops: 0, places: 0, pattern_stops: 0, route_without_pattern: 0, sample_count: 0 }]
        : original(sql, params))
    }],
    ['route_without_pattern', (options) => {
      const original = options.query
      options.query = vi.fn(async (sql, params) => sql.includes('AS route_without_pattern')
        ? [{ routes: 2, patterns: 2, stops: 4, places: 2, pattern_stops: 4, route_without_pattern: 1, sample_count: 2 }]
        : original(sql, params))
    }],
    ['manifest_missing', (options) => { options.r2.getManifest = vi.fn(async () => null) }],
    ['manifest_read_failed', (options) => { options.r2.getManifest = vi.fn(async () => { throw new Error('oversized manifest') }) }],
    ['manifest_count_mismatch', (options) => {
      const original = options.r2.getManifest
      options.r2.getManifest = vi.fn(async (key) => ({ ...(await original(key)), counts: { ...counts, routes: 99 } }))
    }],
    ['network_missing', (options) => {
      const original = options.r2.head
      options.r2.head = vi.fn(async (key) => key.endsWith('network.json') ? null : original(key))
    }],
    ['network_version_mismatch', (options) => {
      options.r2.readPrefix = vi.fn(async () => '{"schemaVersion":1,"city":"Taipei","version":"wrong",')
    }],
    ['public_version_mismatch', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/routes?')
        ? { schemaVersion: 2, source: 'snapshot', snapshotVersion: 'wrong', routes: [{}, {}] }
        : original(path))
    }],
    ['public_schema_invalid', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/routes?')
        ? { schemaVersion: 1, source: 'snapshot', snapshotVersion: activeVersion, routes: [{}, {}] }
        : original(path))
    }],
    ['public_count_mismatch', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/routes?')
        ? { schemaVersion: 2, source: 'snapshot', snapshotVersion: activeVersion, routes: [{}] }
        : original(path))
    }],
  ])('returns fixed %s for an earlier hard-check failure', async (failureClass, mutate) => {
    const options = fixture()
    mutate(options)
    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'error', probeFailureClass: failureClass, rollbackAvailable: false,
    })
  })

  it.each([
    ['route_version', (path, original) => path.includes('/map/route?')
      ? { schemaVersion: 1, source: 'snapshot', snapshotVersion: previousVersion, variants: [] }
      : original(path)],
    ['route_variant', (path, original) => path.includes('/map/route?')
      ? { schemaVersion: 1, source: 'snapshot', snapshotVersion: activeVersion, variants: [] }
      : original(path)],
    ['route_stops', (path, original) => path.includes('/map/route?')
      ? {
          schemaVersion: 1, source: 'snapshot', snapshotVersion: activeVersion,
          variants: [{
            variantKey: 'PATTERN_PRIVATE', routeUid: 'ROUTE_PRIVATE', stops: { features: [{}] },
          }],
        }
      : original(path)],
  ])('keeps genuine route defects as route_sample_failed at %s', async (failureStage, response) => {
    const options = fixture()
    const original = options.publicApi.getJson
    options.publicApi.getJson = vi.fn(async (path) => response(path, original))

    const result = await probeActiveSnapshot(options)

    expect(result).toMatchObject({ activeProbeResult: 'error', probeFailureClass: 'route_sample_failed', hardChecksPassed: 9 })
    expect(options.diagnosticSink).toHaveBeenCalledWith(expect.objectContaining({
      event: 'snapshot_probe_diagnostic', failureStage, failureClass: 'route_sample_failed', attempt: 1,
      expectedSnapshotVersion: activeVersion,
    }))
  })

  it.each([
    ['place_version', {
      schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: previousVersion,
      routes: [{ variantKey: 'PATTERN_PRIVATE', routeUid: 'ROUTE_PRIVATE' }],
    }],
    ['place_pattern', {
      schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: activeVersion,
      routes: [],
    }],
  ])('keeps genuine place defects as place_bundle_sample_failed at %s', async (failureStage, placeResponse) => {
    const options = fixture()
    const original = options.publicApi.getJson
    options.publicApi.getJson = vi.fn(async (path) => path.includes('/arrivals?') ? placeResponse : original(path))

    const result = await probeActiveSnapshot(options)

    expect(result).toMatchObject({
      activeProbeResult: 'error', probeFailureClass: 'place_bundle_sample_failed', hardChecksPassed: 10,
    })
    expect(options.diagnosticSink).toHaveBeenCalledWith(expect.objectContaining({ failureStage }))
  })

  it.each([
    ['http_error', new Error('Public snapshot probe request failed')],
    ['timeout', Object.assign(new Error('timed out'), { name: 'TimeoutError' })],
    ['network_failure', new TypeError('fetch failed')],
  ])('keeps request failure reason allowlisted as %s', async (requestFailureReason, requestError) => {
    const options = fixture()
    const original = options.publicApi.getJson
    options.publicApi.getJson = vi.fn(async (path) => {
      if (path.includes('/map/route?')) throw requestError
      return original(path)
    })

    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'error', probeFailureClass: 'route_sample_failed', hardChecksPassed: 9,
    })
    expect(options.diagnosticSink).toHaveBeenCalledWith(expect.objectContaining({
      failureStage: 'route_request', requestFailureReason,
    }))
  })

  it('classifies body-limit, JSON parse, and stream failures without exposing content', async () => {
    const oversized = new Response('x'.repeat(32), { headers: { 'Content-Length': '32' } })
    const bodyLimit = await readBoundedResponseJson(oversized, 16).catch((error) => error)
    expect(classifyProbeRequestFailure(bodyLimit)).toBe('body_limit')

    const invalidJson = await readBoundedResponseJson(new Response('{invalid'), 64).catch((error) => error)
    expect(classifyProbeRequestFailure(invalidJson)).toBe('json_parse')

    const stream = new ReadableStream({
      pull(controller) { controller.error(new Error('private stream detail')) },
    })
    const streamFailure = await readBoundedResponseJson(new Response(stream), 64).catch((error) => error)
    expect(classifyProbeRequestFailure(streamFailure)).toBe('stream_failure')
  })

  it('emits an allowlisted bounded diagnostic without raw sample identity or errors', () => {
    const diagnostic = createSnapshotProbeDiagnostic({
      city,
      windowId,
      sampleCaseId: 'case_9545a8a45776',
      samplePatternId: 'PATTERN_PRIVATE',
      sampleRouteUid: 'ROUTE_PRIVATE',
      expectedSnapshotVersion: activeVersion,
      observedSnapshotVersion: null,
      attempt: 1,
      failureStage: 'route_request',
      failureClass: 'route_sample_failed',
      requestFailureReason: 'http_error',
      error: new Error('Bearer private-token'),
      url: 'https://private.example/path',
    })

    expect(Object.keys(diagnostic).sort()).toEqual([
      'attempt', 'city', 'event', 'expectedSnapshotVersion', 'failureClass', 'failureStage',
      'observedSnapshotVersion', 'requestFailureReason', 'sampleCaseId', 'samplePatternHash',
      'sampleRouteHash', 'windowId',
    ].sort())
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toMatch(/PATTERN_PRIVATE|ROUTE_PRIVATE|private-token|https?:\/\/|stack|message/)
    expect(() => createSnapshotProbeDiagnostic({
      ...diagnostic,
      samplePatternId: 'PATTERN_PRIVATE',
      sampleRouteUid: 'ROUTE_PRIVATE',
      requestFailureReason: 'raw_error_message',
    })).toThrow('Invalid snapshot probe request failure reason')
  })

  it('validates the bounded network metadata prefix', () => {
    const metadataFirstPayload = `{"schemaVersion":1,"city":"${city}","version":"${activeVersion}","routes":["${'x'.repeat(64_000)}"]}`
    expect(networkPrefixMatches(metadataFirstPayload.slice(0, 65_536), city, activeVersion)).toBe(true)
    expect(networkPrefixMatches(
      ` { "schemaVersion": 1, "city": "${city}", "version": "${activeVersion}", "routes": [`,
      city,
      activeVersion,
    )).toBe(true)
    expect(networkPrefixMatches('{"schemaVersion":1,"city":"Taipei","version":"wrong",', city, activeVersion)).toBe(false)
    expect(networkPrefixMatches('{"schemaVersion":1,"city":"Taipei","routes":[]}', city, activeVersion)).toBe(false)
  })

  it('cancels an oversized network stream instead of downloading the full object', async () => {
    let pulls = 0
    let cancelled = false
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(32 * 1024))
        if (pulls >= 256) controller.close()
      },
      cancel() { cancelled = true },
    })
    const response = new Response(body)

    const error = await readBoundedResponseText(response, 65_536).catch((caught) => caught)
    expect(classifyProbeRequestFailure(error)).toBe('body_limit')
    expect(pulls).toBeLessThan(256)
    expect(cancelled).toBe(true)
  })
})
