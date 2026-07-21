import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MapEnv } from './map-http-context'
import { readDirectRoutes, readTransferPlans } from './map-journey-plans'

const repository = vi.hoisted(() => ({
  getDirectRoutes: vi.fn(),
  getOneTransferRoutes: vi.fn(),
}))

vi.mock('../infrastructure/transit/snapshot-repository', () => repository)

const bindings = {
  TDX_CLIENT_ID: 'shared-id',
  TDX_CLIENT_SECRET: 'shared-secret',
} as MapEnv['Bindings']

function createApp() {
  const app = new Hono<MapEnv>()
  app.get('/api/v1/map/direct', readDirectRoutes)
  app.get('/api/v1/map/transfer', readTransferPlans)
  return app
}

function request(path: string): Promise<Response> {
  return Promise.resolve(createApp().request(`https://bus.example${path}`, {}, bindings))
}

beforeEach(() => {
  Object.values(repository).forEach((mock) => mock.mockReset())
})

describe('Map journey plan handlers', () => {
  it('preserves direct-route response and repository contract', async () => {
    const routes = [{ routeUid: 'TPE1', routeName: '307' }]
    repository.getDirectRoutes.mockResolvedValue(routes)

    const response = await request('/api/v1/map/direct?city=Taipei&from=PLACE1&to=PLACE2')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      from: 'PLACE1',
      to: 'PLACE2',
      routes,
    })
    expect(repository.getDirectRoutes).toHaveBeenCalledWith(bindings, 'Taipei', 'PLACE1', 'PLACE2')
  })

  it('preserves one-transfer response and repository contract', async () => {
    const plans = [{ transferPlaceId: 'PLACE3', legs: [] }]
    repository.getOneTransferRoutes.mockResolvedValue(plans)

    const response = await request('/api/v1/map/transfer?city=Taipei&from=PLACE1&to=PLACE2')

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=86400')
    await expect(response.json()).resolves.toEqual({
      schemaVersion: 1,
      city: 'Taipei',
      from: 'PLACE1',
      to: 'PLACE2',
      plans,
    })
    expect(repository.getOneTransferRoutes).toHaveBeenCalledWith(bindings, 'Taipei', 'PLACE1', 'PLACE2')
  })

  it('rejects unsupported cities before planning', async () => {
    const direct = await request('/api/v1/map/direct?city=Unknown&from=PLACE1&to=PLACE2')
    const transfer = await request('/api/v1/map/transfer?city=Unknown&from=PLACE1&to=PLACE2')

    expect(direct.status).toBe(400)
    expect(transfer.status).toBe(400)
    expect(direct.headers.get('Cache-Control')).toBe('no-store')
    expect(transfer.headers.get('Cache-Control')).toBe('no-store')
    await expect(direct.json()).resolves.toEqual({ error: '請選擇縣市' })
    await expect(transfer.json()).resolves.toEqual({ error: '請選擇縣市' })
    expect(repository.getDirectRoutes).not.toHaveBeenCalled()
    expect(repository.getOneTransferRoutes).not.toHaveBeenCalled()
  })

  it('keeps direct endpoint input labels', async () => {
    const missingFrom = await request('/api/v1/map/direct?city=Taipei&to=PLACE2')
    const missingTo = await request('/api/v1/map/direct?city=Taipei&from=PLACE1')

    expect(missingFrom.status).toBe(400)
    expect(missingTo.status).toBe(400)
    await expect(missingFrom.json()).resolves.toEqual({ error: '起點不可空白', code: 'INVALID_QUERY' })
    await expect(missingTo.json()).resolves.toEqual({ error: '終點不可空白', code: 'INVALID_QUERY' })
  })

  it('keeps transfer endpoint input labels', async () => {
    const missingFrom = await request('/api/v1/map/transfer?city=Taipei&to=PLACE2')
    const missingTo = await request('/api/v1/map/transfer?city=Taipei&from=PLACE1')

    expect(missingFrom.status).toBe(400)
    expect(missingTo.status).toBe(400)
    await expect(missingFrom.json()).resolves.toEqual({ error: '出發位置不可空白', code: 'INVALID_QUERY' })
    await expect(missingTo.json()).resolves.toEqual({ error: '目的地不可空白', code: 'INVALID_QUERY' })
  })
})
