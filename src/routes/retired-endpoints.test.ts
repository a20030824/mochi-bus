import { afterEach, describe, expect, it, vi } from 'vitest'
import app from '../index'

const retiredPaths = ['/api/eta', '/shortcut', '/bus/text', '/text'] as const

const rateLimitBindings = {
  API_STANDARD_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
  API_EXPENSIVE_RATE_LIMITER: { limit: vi.fn(async () => ({ success: true })) },
} as unknown as CloudflareBindings

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('retired compatibility surfaces', () => {
  it.each(retiredPaths)('does not expose %s', async (path) => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const response = await app.request(`https://bus.moc96336.com${path}`, {}, rateLimitBindings)

    expect(response.status).toBe(404)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
