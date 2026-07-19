import { describe, expect, it, vi } from 'vitest'
import {
  artifactHeadMatches,
  deterministicSampleCaseId,
  deterministicSampleIndex,
  networkPrefixMatches,
  probeActiveSnapshot,
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
        schemaVersion: 1, source: 'snapshot',
        variants: [{ variantKey: sample.pattern_id, stops: { features: [{}, {}] } }],
      }
      if (path.includes('/arrivals?')) return {
        schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: activeVersion,
        routes: [{ variantKey: sample.pattern_id }],
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
    now: () => new Date('2026-07-19T19:29:00.000Z'),
    ...overrides,
  }
}

describe('unchanged active snapshot probe', () => {
  it('requires all hard checks and only reads the network prefix', async () => {
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
    expect(options.r2.readPrefix).toHaveBeenCalledWith(
      `snapshots/${activeVersion}/cities/${city}/network.json`,
      65_536,
    )
    expect(options.r2.getManifest).not.toHaveBeenCalledWith(expect.stringContaining('network.json'))
  })

  it('accepts an active network HEAD without optional Content-Length', async () => {
    const options = fixture()
    const original = options.r2.head
    options.r2.head = vi.fn(async (key) => key.endsWith('network.json') && key.includes(activeVersion)
      ? { size: null }
      : original(key))

    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'success',
      probeFailureClass: 'none',
      rollbackAvailable: true,
      hardChecksPassed: 11,
    })
  })

  it('keeps rollback available when the previous network HEAD omits Content-Length', async () => {
    const options = fixture()
    const original = options.r2.head
    options.r2.head = vi.fn(async (key) => key.endsWith('network.json') && key.includes(previousVersion)
      ? { size: null }
      : original(key))

    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'success',
      rollbackAvailable: true,
      hardChecksPassed: 11,
    })
  })

  it('still reports network_missing when HEAD provides a mismatched size', async () => {
    const options = fixture()
    const original = options.r2.head
    options.r2.head = vi.fn(async (key) => key.endsWith('network.json') && key.includes(activeVersion)
      ? { size: 7_999_999 }
      : original(key))

    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'error',
      probeFailureClass: 'network_missing',
      rollbackAvailable: false,
    })
  })

  it('matches optional HEAD metadata without treating a real zero as unknown', () => {
    expect(artifactHeadMatches({ size: null }, { bytes: 100 })).toBe(true)
    expect(artifactHeadMatches({}, { bytes: 100 })).toBe(true)
    expect(artifactHeadMatches({ size: 100 }, { bytes: 100 })).toBe(true)
    expect(artifactHeadMatches({ size: 99 }, { bytes: 100 })).toBe(false)
    expect(artifactHeadMatches({ size: 0 }, { bytes: 100 })).toBe(false)
    expect(artifactHeadMatches(null, { bytes: 100 })).toBe(false)
    expect(artifactHeadMatches({ size: 100 }, { bytes: 0 })).toBe(false)
    expect(artifactHeadMatches({ size: 100 }, { bytes: 'invalid' })).toBe(false)
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

  it('passes when realtime is unavailable but the active place bundle is valid', async () => {
    const options = fixture()
    const original = options.publicApi.getJson
    options.publicApi.getJson = vi.fn(async (path) => path.includes('/arrivals?')
      ? {
          schemaVersion: 1,
          scheduleSource: 'place-bundle',
          snapshotVersion: activeVersion,
          warning: 'tdx-rate-limit',
          routes: [{ variantKey: 'PATTERN_PRIVATE', source: 'schedule' }],
        }
      : original(path))

    await expect(probeActiveSnapshot(options)).resolves.toMatchObject({
      activeProbeResult: 'success',
      hardChecksPassed: 11,
    })
  })

  it('does not claim rollback availability when the previous network version is inconsistent', async () => {
    const options = fixture()
    const original = options.r2.readPrefix
    options.r2.readPrefix = vi.fn(async (key, maximumBytes) => key.includes(previousVersion)
      ? `{"schemaVersion":1,"city":"${city}","version":"wrong","routes":[`
      : original(key, maximumBytes))

    const result = await probeActiveSnapshot(options)
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
    ['route_sample_failed', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/map/route?')
        ? { schemaVersion: 1, source: 'snapshot', variants: [] }
        : original(path))
    }],
    ['place_bundle_sample_failed', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/arrivals?')
        ? { schemaVersion: 1, scheduleSource: 'route-objects', routes: [] }
        : original(path))
    }],
    ['place_bundle_sample_failed', (options) => {
      const original = options.publicApi.getJson
      options.publicApi.getJson = vi.fn(async (path) => path.includes('/arrivals?')
        ? {
            schemaVersion: 1, scheduleSource: 'place-bundle', snapshotVersion: 'wrong',
            routes: [{ variantKey: 'PATTERN_PRIVATE' }],
          }
        : original(path))
    }],
  ])('returns fixed %s without exposing private sample identity', async (failureClass, mutate) => {
    const options = fixture()
    mutate(options)
    const result = await probeActiveSnapshot(options)
    expect(result).toMatchObject({ activeProbeResult: 'error', probeFailureClass: failureClass, rollbackAvailable: false })
    expect(JSON.stringify(result)).not.toMatch(/PATTERN_PRIVATE|ROUTE_PRIVATE|ROUTE_NAME_PRIVATE|PLACE_PRIVATE|snapshots\//)
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
    expect(networkPrefixMatches('{"schemaVersion":1,"city":"Taipei","vers', city, activeVersion)).toBe(false)
    expect(networkPrefixMatches('{"schemaVersion":1,"city":"Taipei","routes":[]}', city, activeVersion)).toBe(false)
    expect(networkPrefixMatches(
      `{"padding":"${'x'.repeat(65_000)}","schemaVersion":1,"city":"${city}","version":"${activeVersion}"}`,
      city,
      activeVersion,
    )).toBe(false)
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

    await expect(readBoundedResponseText(response, 65_536)).rejects.toThrow('Bounded response is too large')
    expect(pulls).toBeLessThan(256)
    expect(cancelled).toBe(true)
  })
})
