import { describe, expect, it, vi } from 'vitest'
import {
  ReleaseSmokeError,
  discoverAssetGraph,
  runPostDeploySmoke,
  safeReleaseSmokeDiagnostic,
  selectRepresentativeRoute,
  validateArrivalsContract,
  validateReleaseIdentity,
  validateRouteContract,
  validateRoutesContract,
} from './post-deploy.mjs'

const expectedSha = '0123456789abcdef0123456789abcdef01234567'
const release = (releaseSha = expectedSha) => ({
  schemaVersion: 1,
  releaseSha,
  workerVersionId: 'worker-version-1',
  workerCreatedAt: '2026-07-22T16:30:00.000Z',
})

describe('post-deploy release identity', () => {
  it('accepts only the exact deployed SHA with bounded Worker identity', () => {
    expect(validateReleaseIdentity(release(), expectedSha)).toEqual(release())
    expect(() => validateReleaseIdentity(release('f'.repeat(40)), expectedSha))
      .toThrowError(expect.objectContaining({ code: 'release_not_observed' }))
    expect(() => validateReleaseIdentity({ ...release(), workerVersionId: null }, expectedSha))
      .toThrowError(expect.objectContaining({ code: 'release_identity_invalid' }))
  })
})

describe('post-deploy asset graph', () => {
  it('starts from HTML and recursively verifies same-origin JS/CSS dependencies including hashed chunks', async () => {
    const bodies = new Map([
      ['/assets/map.js', {
        contentType: 'text/javascript',
        body: 'import "./map-runtime-a1b2c3.js"; import("./lazy-d4e5f6.js");',
      }],
      ['/assets/map.css', {
        contentType: 'text/css',
        body: '@import "./leaflet-7a8b9c.css"; .marker{background:url("/icon.svg")}',
      }],
      ['/assets/map-runtime-a1b2c3.js', { contentType: 'text/javascript', body: 'export const ready = true' }],
      ['/assets/lazy-d4e5f6.js', { contentType: 'text/javascript', body: 'export default 1' }],
      ['/assets/leaflet-7a8b9c.css', { contentType: 'text/css', body: '.leaflet{}' }],
      ['/icon.svg', { contentType: 'image/svg+xml', body: '<svg></svg>' }],
    ])
    const readAsset = vi.fn(async (path) => {
      const value = bodies.get(path)
      if (!value) throw new Error(`unexpected ${path}`)
      return value
    })

    const graph = await discoverAssetGraph({
      html: '<link rel="stylesheet" href="/assets/map.css"><script type="module" src="/assets/map.js"></script><script src="https://example.invalid/ignored.js"></script>',
      readAsset,
      maxAssets: 12,
    })

    expect(graph).toEqual([
      '/assets/map.css',
      '/assets/map.js',
      '/assets/leaflet-7a8b9c.css',
      '/icon.svg',
      '/assets/map-runtime-a1b2c3.js',
      '/assets/lazy-d4e5f6.js',
    ])
    expect(readAsset).toHaveBeenCalledTimes(6)
  })

  it('fails closed for an empty or unbounded asset graph', async () => {
    await expect(discoverAssetGraph({ html: '<html></html>', readAsset: vi.fn() }))
      .rejects.toMatchObject({ code: 'page_assets_missing' })
    await expect(discoverAssetGraph({
      html: '<script src="/assets/a.js"></script>',
      maxAssets: 1,
      readAsset: vi.fn(async () => ({ contentType: 'text/javascript', body: 'import "./b.js"' })),
    })).rejects.toMatchObject({ code: 'asset_graph_limit' })
  })
})

describe('representative public API contracts', () => {
  const taipeiRoutes = validateRoutesContract({
    schemaVersion: 2,
    city: 'Taipei',
    source: 'snapshot',
    snapshotVersion: 'v1',
    routes: [
      { routeUid: 'TPE-FIRST', routeName: '0東' },
      { routeUid: 'TPE307-B', routeName: '307' },
      { routeUid: 'TPE307-A', routeName: '307' },
    ],
  }, 'Taipei')

  it('requires snapshot-backed route catalogues and a non-empty version', () => {
    expect(taipeiRoutes).toMatchObject({ snapshotVersion: 'v1' })
    expect(() => validateRoutesContract({
      schemaVersion: 2, city: 'Taipei', source: 'tdx', snapshotVersion: null, routes: [],
    }, 'Taipei')).toThrowError(expect.objectContaining({ code: 'routes_contract_invalid' }))
  })

  it('derives every current identity for the fixed route name instead of hardcoding a RouteUID', () => {
    expect(selectRepresentativeRoute(taipeiRoutes, '307')).toEqual({
      routeName: '307',
      routeUids: ['TPE307-A', 'TPE307-B'],
    })
    expect(() => selectRepresentativeRoute(taipeiRoutes, 'missing'))
      .toThrowError(expect.objectContaining({ code: 'route_sample_missing' }))
  })

  it('requires route detail to intersect the validated catalogue identities and expose usable stops', () => {
    const route = { routeName: '307', routeUids: ['TPE307-A', 'TPE307-B'] }
    const invalidVariant = {
      variantKey: 'OTHER-0:0:0',
      routeName: '307',
      routeUid: 'TPE-OTHER',
      stops: {
        features: [
          { properties: { stopUid: 'TPE000' } },
          { properties: { stopUid: 'TPE001' } },
        ],
      },
    }
    const validVariant = {
      variantKey: 'TPE307-B-0:0:0',
      routeName: '307',
      routeUid: 'TPE307-B',
      stops: {
        features: [
          { properties: { stopUid: 'TPE100' } },
          { properties: { stopUid: 'TPE213044' } },
        ],
      },
    }
    expect(validateRouteContract({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      source: 'snapshot',
      variants: [invalidVariant, validVariant],
    }, 'Taipei', route)).toBe(validVariant)
    expect(() => validateRouteContract({
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      source: 'snapshot',
      variants: [invalidVariant],
    }, 'Taipei', route)).toThrowError(expect.objectContaining({ code: 'route_contract_invalid' }))
  })

  it('accepts healthy or degraded arrivals only when fallback fields remain structurally usable', () => {
    expect(validateArrivalsContract({
      schemaVersion: 1,
      city: 'Taipei',
      scheduleSource: 'place-bundle',
      snapshotVersion: 'v1',
      warning: 'tdx-rate-limit',
      realtime: { candidates: 1, queries: 0, rateLimited: true },
      routes: [{ routeUid: 'TPE307', routeName: '307', source: 'schedule', estimateSeconds: 300 }],
    }, 'Taipei', 'v1')).toMatchObject({ warning: 'tdx-rate-limit' })
    expect(() => validateArrivalsContract({
      schemaVersion: 1,
      city: 'Taipei',
      scheduleSource: 'place-bundle',
      snapshotVersion: 'v1',
      warning: 'raw-upstream-error',
      realtime: { candidates: 1, queries: 0, rateLimited: true },
      routes: [],
    }, 'Taipei', 'v1')).toThrowError(expect.objectContaining({ code: 'degraded_contract_invalid' }))
  })
})

describe('true post-deploy smoke orchestration', () => {
  it('waits for the exact release, runs HTTP and fresh-browser smoke, observes it, then repeats HTTP postflight', async () => {
    let clock = 0
    const documents = [release('f'.repeat(40)), release(), release(), release()]
    const readRelease = vi.fn(async () => documents.shift() ?? release())
    const probeHttp = vi.fn(async ({ phase }) => ({ phase, pages: 3, assets: 6, cities: 2 }))
    const probeBrowser = vi.fn(async () => ({ pages: 3, pageErrors: 0, consoleErrors: 0, chunkFailures: 0 }))
    const sleep = vi.fn(async (milliseconds) => { clock += milliseconds })

    const report = await runPostDeploySmoke({
      expectedSha,
      readRelease,
      probeHttp,
      probeBrowser,
      now: () => clock,
      sleep,
      propagationTimeoutMs: 5_000,
      pollIntervalMs: 1_000,
      observationWindowMs: 2_000,
      observationIntervalMs: 1_000,
    })

    expect(report).toMatchObject({
      schemaVersion: 1,
      result: 'success',
      releaseSha: expectedSha,
      workerVersionId: 'worker-version-1',
      initialHttp: { phase: 'initial' },
      finalHttp: { phase: 'final' },
      browser: { pageErrors: 0, consoleErrors: 0, chunkFailures: 0 },
      observationChecks: 2,
    })
    expect(probeHttp).toHaveBeenNthCalledWith(1, expect.objectContaining({ phase: 'initial', releaseSha: expectedSha }))
    expect(probeHttp).toHaveBeenNthCalledWith(2, expect.objectContaining({ phase: 'final', releaseSha: expectedSha }))
    expect(probeBrowser).toHaveBeenCalledTimes(1)
  })

  it('fails when the expected release never propagates or changes during the observation window', async () => {
    let clock = 0
    await expect(runPostDeploySmoke({
      expectedSha,
      readRelease: vi.fn(async () => release('f'.repeat(40))),
      probeHttp: vi.fn(),
      probeBrowser: vi.fn(),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      propagationTimeoutMs: 2_000,
      pollIntervalMs: 1_000,
      observationWindowMs: 0,
    })).rejects.toMatchObject({ code: 'release_propagation_timeout' })

    clock = 0
    const readRelease = vi.fn()
      .mockResolvedValueOnce(release())
      .mockResolvedValueOnce(release('e'.repeat(40)))
    await expect(runPostDeploySmoke({
      expectedSha,
      readRelease,
      probeHttp: vi.fn(async ({ phase }) => ({ phase })),
      probeBrowser: vi.fn(async () => ({ pages: 3, pageErrors: 0, consoleErrors: 0, chunkFailures: 0 })),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      propagationTimeoutMs: 1_000,
      pollIntervalMs: 100,
      observationWindowMs: 1_000,
      observationIntervalMs: 1_000,
    })).rejects.toMatchObject({ code: 'release_changed_during_observation' })
  })

  it('emits only allowlisted bounded failure diagnostics', () => {
    const raw = Object.assign(new Error('https://secret.example/?token=abc'), {
      code: 'browser_console_error',
      stack: 'token=abc',
    })
    const diagnostic = safeReleaseSmokeDiagnostic(raw, expectedSha)
    expect(diagnostic).toEqual({
      event: 'release_smoke_completed',
      result: 'error',
      releaseSha: expectedSha,
      failureClass: 'browser_console_error',
    })
    expect(JSON.stringify(diagnostic)).not.toMatch(/secret|token|https|stack|message/i)
    expect(safeReleaseSmokeDiagnostic(new ReleaseSmokeError('page_http_failed'), expectedSha).failureClass)
      .toBe('page_http_failed')
    expect(safeReleaseSmokeDiagnostic(new ReleaseSmokeError('route_http_failed'), expectedSha).failureClass)
      .toBe('route_http_failed')
  })
})
