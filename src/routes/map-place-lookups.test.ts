import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapEnv } from './map-http-context'
import {
  findNearbyPlaces,
  readPlace,
  readPlaceRoutes,
  readStopPlace,
  searchPlaces,
} from './map-place-lookups'

const repository = vi.hoisted(() => ({
  searchStopPlaces: vi.fn(),
  findNearbyStopPlaces: vi.fn(),
  getStopPlaceRoutes: vi.fn(),
  getStopPlace: vi.fn(),
  getStopPlaceByStopUid: vi.fn(),
}))

vi.mock('../infrastructure/transit/snapshot-repository', () => repository)

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
} as MapEnv['Bindings']

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/search', searchPlaces)
  app.get('/api/v1/map/nearby', findNearbyPlaces)
  app.get('/api/v1/map/place/:placeId/routes', readPlaceRoutes)
  app.get('/api/v1/map/place/:placeId', readPlace)
  app.get('/api/v1/map/stop-place', readStopPlace)
  return app
}

function request(path: string): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, {}, bindings))
}

const place = {
  placeId: 'PLACE1',
  name: '測試站',
  latitude: 25.0478,
  longitude: 121.517,
  stopUids: ['STOP1'],
}

beforeEach(() => {
  Object.values(repository).forEach((mock) => mock.mockReset())
})

describe('Map Place lookup handlers', () => {
  it('preserves search response and cache contract', async () => {
    repository.searchStopPlaces.mockResolvedValue([place])

    const response = await request('/api/v1/map/search?city=Taipei&q=%E6%B8%AC%E8%A9%A6')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      query: '測試',
      places: [place],
    })
    expect(repository.searchStopPlaces).toHaveBeenCalledWith(bindings, 'Taipei', '測試')
  })

  it('rejects invalid search input before repository access', async () => {
    const response = await request('/api/v1/map/search?city=Unknown&q=%E6%B8%AC%E8%A9%A6')

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '請選擇縣市' })
    expect(repository.searchStopPlaces).not.toHaveBeenCalled()
  })

  it('preserves nearby parsing, response, and cache contract', async () => {
    repository.findNearbyStopPlaces.mockResolvedValue([place])

    const response = await request('/api/v1/map/nearby?city=Taipei&lat=25.0478&lon=121.517&radius=500')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=300')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      radius: 500,
      places: [place],
    })
    expect(repository.findNearbyStopPlaces).toHaveBeenCalledWith(bindings, 'Taipei', 25.0478, 121.517, 500)
  })

  it('preserves Place routes schema and long-lived cache contract', async () => {
    const routes = [{ routeUid: 'TPE1', routeName: '307', stopUid: 'STOP1', direction: 0 }]
    repository.getStopPlaceRoutes.mockResolvedValue(routes)

    const response = await request('/api/v1/map/place/PLACE1/routes?city=Taipei')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(response.json()).resolves.toEqual({ schemaVersion: 3, city: 'Taipei', routes })
    expect(repository.getStopPlaceRoutes).toHaveBeenCalledWith(bindings, 'Taipei', 'PLACE1')
  })

  it('preserves Place detail success and not-found responses', async () => {
    repository.getStopPlace.mockResolvedValueOnce(place).mockResolvedValueOnce(undefined)

    const found = await request('/api/v1/map/place/PLACE1?city=Taipei')
    expect(found.status).toBe(200)
    expect(found.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(found.json()).resolves.toEqual({ schemaVersion: 1, city: 'Taipei', place })

    const missing = await request('/api/v1/map/place/MISSING?city=Taipei')
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({ error: '找不到這個站牌' })
  })

  it('preserves StopUID lookup response and cache contract', async () => {
    repository.getStopPlaceByStopUid.mockResolvedValue(place)

    const response = await request('/api/v1/map/stop-place?city=Taipei&stopUid=STOP1')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      stopUid: 'STOP1',
      place,
    })
    expect(repository.getStopPlaceByStopUid).toHaveBeenCalledWith(bindings, 'Taipei', 'STOP1')
  })
})
