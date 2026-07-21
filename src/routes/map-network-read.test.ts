import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapEnv } from './map-http-context'
import { readCityNetwork } from './map-network-read'

const repository = vi.hoisted(() => ({ getCityNetwork: vi.fn() }))

vi.mock('../infrastructure/transit/snapshot-repository', () => repository)

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
  TRANSIT_DB: {} as D1Database,
  TRANSIT_SHAPES: {} as R2Bucket,
} as MapEnv['Bindings']

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/network', readCityNetwork)
  return app
}

function request(path: string): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, {}, bindings))
}

function streamBody(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(content))
      controller.close()
    },
  })
}

beforeEach(() => {
  repository.getCityNetwork.mockReset()
})

describe('Map city network handler', () => {
  it('passes a large R2 bundle through without wrapping or reserializing it', async () => {
    const payload = '{"schemaVersion":1,"city":"Taipei","routes":[{"routeName":"307"}],"places":[]}'
    repository.getCityNetwork.mockResolvedValue({
      kind: 'stream',
      body: streamBody(payload),
      etag: '"network-etag"',
    })

    const response = await request('/api/v1/map/network?city=Taipei')

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    expect(response.headers.get('ETag')).toBe('"network-etag"')
    await expect(response.text()).resolves.toBe(payload)
    expect(repository.getCityNetwork).toHaveBeenCalledWith(bindings, 'Taipei')
  })

  it('adds the HTTP envelope only for the inline fallback', async () => {
    repository.getCityNetwork.mockResolvedValue({
      kind: 'inline',
      network: {
        version: 'snapshot-v1',
        routes: [{
          routeName: '307',
          variantKey: 'PATTERN-OUT',
          label: '板橋 → 撫遠街',
          shape: {
            type: 'Feature',
            properties: { routeUid: 'TPE307', direction: 0 },
            geometry: { type: 'LineString', coordinates: [[121.5, 25], [121.6, 25.1]] },
          },
        }],
        places: [{ placeId: 'PLACE-1', name: '台北車站', latitude: 25.0478, longitude: 121.517 }],
      },
    })

    const response = await request('/api/v1/map/network?city=Taipei')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    expect(response.headers.get('ETag')).toBeNull()
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      version: 'snapshot-v1',
      routes: [expect.objectContaining({ routeName: '307', variantKey: 'PATTERN-OUT' })],
      places: [{ placeId: 'PLACE-1', name: '台北車站', latitude: 25.0478, longitude: 121.517 }],
    })
  })

  it('preserves the not-found response when no network can be built', async () => {
    repository.getCityNetwork.mockResolvedValue(null)

    const response = await request('/api/v1/map/network?city=Taipei')

    expect(response.status).toBe(404)
    await expect(response.json()).resolves.toEqual({ error: '這個縣市尚未建立全路網資料' })
  })

  it('rejects an invalid city before reading the repository', async () => {
    const response = await request('/api/v1/map/network?city=Unknown')

    expect(response.status).toBe(400)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '請選擇縣市' })
    expect(repository.getCityNetwork).not.toHaveBeenCalled()
  })

  it('preserves the terminal network error contract', async () => {
    repository.getCityNetwork.mockRejectedValue(new Error('R2 unavailable'))

    const response = await request('/api/v1/map/network?city=Taipei')

    expect(response.status).toBe(502)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    await expect(response.json()).resolves.toEqual({ error: '全路網讀取失敗' })
  })
})
