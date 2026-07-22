import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteMapVariant } from '../domain/map/map-model'
import type { MapEnv } from './map-http-context'
import { readPlaceArrivals } from './map-place-arrivals'
import { readRouteCatalog } from './map-route-catalog'
import { readRouteMap } from './map-route-reads'

const candidateVersion = '20260722T111540779Z'
const previousVersion = '20260720T204419330Z'
const windowId = 'v1:Hsinchu:2026-07-22:manual'

const probeRepository = vi.hoisted(() => ({
  getAuthoritativeActiveSnapshotVersion: vi.fn(),
  getPinnedSnapshotRouteCatalog: vi.fn(),
  getPinnedSnapshotRouteVariant: vi.fn(),
  getPinnedSnapshotRouteVariants: vi.fn(),
  getPinnedStopPlaceBundle: vi.fn(),
}))
const repository = vi.hoisted(() => ({
  getActiveSnapshotVersion: vi.fn(),
  getSnapshotRouteCatalog: vi.fn(),
  getSnapshotRouteVariants: vi.fn(),
  getSnapshotSchedule: vi.fn(),
  getStopPlaceBundle: vi.fn(),
  getStopPlaceRoutes: vi.fn(),
}))
const tdx = vi.hoisted(() => ({
  getRouteCatalog: vi.fn(),
  resolveTDXJson: vi.fn(),
  tdxCredentialScope: vi.fn(),
  isRejectedUserTdxToken: vi.fn(),
  tdxWarningFromError: vi.fn(),
}))
const tdxMap = vi.hoisted(() => ({ getRouteMapVariants: vi.fn() }))
const memory = vi.hoisted(() => ({ memoryCacheGet: vi.fn(), memoryCacheSet: vi.fn() }))
const edge = vi.hoisted(() => ({ cacheMatchFailOpen: vi.fn(), cachePutFailOpen: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-probe-repository', () => probeRepository)
vi.mock('../infrastructure/transit/snapshot-repository', () => repository)
vi.mock('../infrastructure/tdx/map', () => tdxMap)
vi.mock('../lib/tdx', async (importOriginal) => ({
  ...await importOriginal<typeof import('../lib/tdx')>(),
  getRouteCatalog: tdx.getRouteCatalog,
  resolveTDXJson: tdx.resolveTDXJson,
  tdxCredentialScope: tdx.tdxCredentialScope,
  isRejectedUserTdxToken: tdx.isRejectedUserTdxToken,
  tdxWarningFromError: tdx.tdxWarningFromError,
}))
vi.mock('../lib/memory-cache', () => memory)
vi.mock('../lib/edge-cache', () => edge)

const metadata = {
  id: 'worker-version-id',
  tag: '0123456789abcdef0123456789abcdef01234567',
  timestamp: '2026-07-22T10:00:00.000Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
  CF_VERSION_METADATA: metadata,
} as MapEnv['Bindings']

const routeCatalogItem = {
  routeUid: 'HSZ000701',
  routeName: '藍1區',
  departure: 'A',
  destination: 'B',
  category: 'city-bus',
}

const variant: RouteMapVariant = {
  variantKey: 'HSZ000701:0:0',
  routeName: '藍1區',
  routeUid: 'HSZ000701',
  subRouteUid: 'HSZ0007010',
  direction: 0,
  label: 'A → B',
  subRouteName: '藍1區',
  shape: {
    type: 'Feature',
    properties: { routeUid: 'HSZ000701', direction: 0 },
    geometry: { type: 'LineString', coordinates: [[120.9, 24.8], [120.91, 24.81]] },
  },
  stops: {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: { stopUid: 'S1', stopName: '一站', sequence: 1 },
        geometry: { type: 'Point', coordinates: [120.9, 24.8] },
      },
      {
        type: 'Feature',
        properties: { stopUid: 'S2', stopName: '二站', sequence: 2 },
        geometry: { type: 'Point', coordinates: [120.91, 24.81] },
      },
    ],
  },
  updatedAt: null,
}

const bundle = {
  version: candidateVersion,
  placeId: 'Hsinchu:1ifw3fu',
  name: '一站',
  routes: [{
    routeUid: 'HSZ000701',
    routeName: '藍1區',
    variantKey: 'HSZ000701:0:0',
    direction: 0 as const,
    label: 'A → B',
    subRouteUid: 'HSZ0007010',
    subRouteName: '藍1區',
    stopUid: 'S1',
    stopSequence: 1,
    stopName: '一站',
    schedules: [],
  }],
}

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/routes', readRouteCatalog)
  app.get('/api/v1/map/route', readRouteMap)
  app.get('/api/v1/map/place/:placeId/arrivals', readPlaceArrivals)
  return app
}

function request(path: string): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, {}, bindings))
}

function pinned(path: string) {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}snapshot=${candidateVersion}&probe=${encodeURIComponent(windowId)}`
}

function exactRoute(path = '/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80') {
  return pinned(`${path}&routeUid=HSZ000701&patternId=${encodeURIComponent('HSZ000701:0:0')}`)
}

describe('snapshot-pinned public reads', () => {
  beforeEach(() => {
    Object.values(probeRepository).forEach((mock) => mock.mockReset())
    Object.values(repository).forEach((mock) => mock.mockReset())
    Object.values(tdx).forEach((mock) => mock.mockReset())
    Object.values(tdxMap).forEach((mock) => mock.mockReset())
    Object.values(memory).forEach((mock) => mock.mockReset())
    Object.values(edge).forEach((mock) => mock.mockReset())
    probeRepository.getAuthoritativeActiveSnapshotVersion.mockResolvedValue(candidateVersion)
    probeRepository.getPinnedSnapshotRouteCatalog.mockResolvedValue([routeCatalogItem])
    probeRepository.getPinnedSnapshotRouteVariant.mockResolvedValue(variant)
    probeRepository.getPinnedSnapshotRouteVariants.mockResolvedValue([variant])
    probeRepository.getPinnedStopPlaceBundle.mockResolvedValue(bundle)
    tdx.tdxCredentialScope.mockResolvedValue('shared-scope')
    tdx.isRejectedUserTdxToken.mockReturnValue(false)
    tdx.tdxWarningFromError.mockReturnValue(undefined)
    memory.memoryCacheGet.mockReturnValue(undefined)
    edge.cacheMatchFailOpen.mockResolvedValue(undefined)
    edge.cachePutFailOpen.mockResolvedValue(undefined)
    vi.stubGlobal('caches', { default: {} })
    vi.spyOn(Math, 'random').mockReturnValue(0)
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('serves route catalogue from the requested candidate without the active cache or TDX', async () => {
    const response = await request(pinned('/api/v1/map/routes?city=Hsinchu'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      source: 'snapshot', snapshotVersion: candidateVersion, routes: [routeCatalogItem],
    })
    expect(probeRepository.getPinnedSnapshotRouteCatalog)
      .toHaveBeenCalledWith(bindings, 'Hsinchu', candidateVersion)
    expect(repository.getSnapshotRouteCatalog).not.toHaveBeenCalled()
    expect(tdx.getRouteCatalog).not.toHaveBeenCalled()
  })

  it('serves only the exact route UID and pattern requested by the active probe', async () => {
    const response = await request(exactRoute())

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      source: 'snapshot', snapshotVersion: candidateVersion,
      variants: [{ variantKey: 'HSZ000701:0:0', routeUid: 'HSZ000701' }],
    })
    expect(probeRepository.getPinnedSnapshotRouteVariant)
      .toHaveBeenCalledWith(bindings, 'Hsinchu', 'HSZ000701', 'HSZ000701:0:0', candidateVersion)
    expect(probeRepository.getPinnedSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(repository.getSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it('keeps snapshot-only publisher smoke on the grouped route-name path', async () => {
    const response = await request(
      `/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80&snapshot=${candidateVersion}`,
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(probeRepository.getPinnedSnapshotRouteVariants)
      .toHaveBeenCalledWith(bindings, 'Hsinchu', '藍1區', candidateVersion)
    expect(probeRepository.getPinnedSnapshotRouteVariant).not.toHaveBeenCalled()
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it('does not let another same-name RouteUID contaminate an exact healthy sample', async () => {
    const unrelated: RouteMapVariant = { ...variant, routeUid: 'HSZ_OTHER', variantKey: 'HSZ_OTHER:0:0' }
    probeRepository.getPinnedSnapshotRouteVariants.mockResolvedValue([variant, unrelated])

    const response = await request(exactRoute())

    expect(response.status).toBe(200)
    const body = await response.json() as { variants: RouteMapVariant[] }
    expect(body.variants).toEqual([variant])
    expect(probeRepository.getPinnedSnapshotRouteVariants).not.toHaveBeenCalled()
  })

  it('fails closed when route UID and pattern ID do not resolve to the requested route', async () => {
    probeRepository.getPinnedSnapshotRouteVariant.mockResolvedValue(null)

    const response = await request(exactRoute())

    expect(response.status).toBe(404)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(repository.getSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it('fails closed when exact identity resolves to a different route name', async () => {
    probeRepository.getPinnedSnapshotRouteVariant.mockResolvedValue({ ...variant, routeName: '另一條路線' })

    const response = await request(exactRoute())

    expect(response.status).toBe(404)
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })

  it.each([
    '/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80&routeUid=HSZ000701',
    '/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80&patternId=HSZ000701%3A0%3A0',
    '/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80&routeUid=bad%20uid&patternId=HSZ000701%3A0%3A0',
  ])('rejects incomplete or invalid exact identity before data access', async (path) => {
    const response = await request(pinned(path))

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(probeRepository.getPinnedSnapshotRouteVariant).not.toHaveBeenCalled()
    expect(probeRepository.getPinnedSnapshotRouteVariants).not.toHaveBeenCalled()
  })

  it('does not expose exact identity selectors without a validated probe window', async () => {
    const response = await request(
      `/api/v1/map/route?city=Hsinchu&route=%E8%97%8D1%E5%8D%80&routeUid=HSZ000701&patternId=HSZ000701%3A0%3A0&snapshot=${candidateVersion}`,
    )

    expect(response.status).toBe(400)
    expect(probeRepository.getPinnedSnapshotRouteVariant).not.toHaveBeenCalled()
  })

  it('serves the requested place bundle without realtime, fallback objects, or shared caches', async () => {
    const response = await request(pinned('/api/v1/map/place/Hsinchu%3A1ifw3fu/arrivals?city=Hsinchu'))

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toMatchObject({
      scheduleSource: 'place-bundle',
      snapshotVersion: candidateVersion,
      realtime: { candidates: 0, queries: 0, rateLimited: false },
      routes: [{ variantKey: 'HSZ000701:0:0' }],
    })
    expect(probeRepository.getPinnedStopPlaceBundle)
      .toHaveBeenCalledWith(expect.any(Object), 'Hsinchu', 'Hsinchu:1ifw3fu', candidateVersion)
    expect(repository.getStopPlaceBundle).not.toHaveBeenCalled()
    expect(repository.getStopPlaceRoutes).not.toHaveBeenCalled()
    expect(repository.getSnapshotSchedule).not.toHaveBeenCalled()
    expect(tdx.resolveTDXJson).not.toHaveBeenCalled()
    expect(memory.memoryCacheGet).not.toHaveBeenCalled()
    expect(edge.cacheMatchFailOpen).not.toHaveBeenCalled()
  })

  it('fails closed before data access when the requested version is not D1 active', async () => {
    probeRepository.getAuthoritativeActiveSnapshotVersion.mockResolvedValue(previousVersion)

    const response = await request(exactRoute())

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({
      error: '指定快照目前不可用', code: 'INVALID_QUERY',
    })
    expect(probeRepository.getPinnedSnapshotRouteVariant).not.toHaveBeenCalled()
    expect(probeRepository.getPinnedSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(repository.getSnapshotRouteVariants).not.toHaveBeenCalled()
    expect(tdxMap.getRouteMapVariants).not.toHaveBeenCalled()
  })
})
