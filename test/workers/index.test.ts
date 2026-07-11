import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

// 這裡測的是真正的 Cloudflare Workers runtime 語意(security headers
// middleware、Hono bodyLimit、308 redirect),不是 Node 環境能驗證的東西;
// 純 domain 邏輯測試留在一般 Node 環境的 vitest 專案就好,跑得快。
describe('worker entry (Workers runtime)', () => {
  it('redirects bare HTTP to HTTPS with a 308 and keeps query/path', async () => {
    const response = await SELF.fetch('http://example.com/map?city=Chiayi', { redirect: 'manual' })
    expect(response.status).toBe(308)
    expect(response.headers.get('location')).toBe('https://example.com/map?city=Chiayi')
  })

  it('does not redirect an already-HTTPS request', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/map/cities', { redirect: 'manual' })
    expect(response.status).toBe(200)
  })

  it('attaches HSTS and frame protection headers on a normal response', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/map/cities')
    expect(response.headers.get('strict-transport-security')).toBeTruthy()
    expect(response.headers.get('x-frame-options')).toBe('DENY')
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
  })

  it('returns the static city list without touching D1/R2', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/map/cities')
    const body = await response.json<{ cities: Array<{ code: string }> }>()
    expect(body.cities.length).toBeGreaterThan(0)
  })

  it('rejects an oversized journey-eta body with 413 before parsing JSON', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/map/journey-eta', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(20 * 1024),
    })
    expect(response.status).toBe(413)
    const body = await response.json<{ code?: string }>()
    expect(body.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('returns 404 for an unknown route', async () => {
    const response = await SELF.fetch('https://example.com/api/v1/does-not-exist')
    expect(response.status).toBe(404)
  })
})
