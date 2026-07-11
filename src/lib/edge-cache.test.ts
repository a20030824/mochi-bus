import { afterEach, describe, expect, it, vi } from 'vitest'
import { cacheMatchFailOpen, cachePutFailOpen } from './edge-cache'

describe('edge cache resilience', () => {
  afterEach(() => vi.restoreAllMocks())

  it('treats a cache read failure as a miss', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = {
      match: vi.fn(async () => { throw new Error('cache unavailable') }),
    } as unknown as Cache

    await expect(cacheMatchFailOpen(cache, new Request('https://cache.invalid/read'), 'test')).resolves.toBeUndefined()
  })

  it('does not let a cache write rejection fail the request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = {
      put: vi.fn(async () => { throw new Error('write rejected') }),
    } as unknown as Cache

    await expect(cachePutFailOpen(
      cache,
      new Request('https://cache.invalid/write'),
      new Response('value'),
      'test',
    )).resolves.toBeUndefined()
  })

  it('schedules cache writes without waiting for them to finish', async () => {
    let finishWrite!: () => void
    const pendingWrite = new Promise<void>((resolve) => { finishWrite = resolve })
    const cache = { put: vi.fn(() => pendingWrite) } as unknown as Cache
    let scheduled: Promise<unknown> | undefined

    await cachePutFailOpen(
      cache,
      new Request('https://cache.invalid/background'),
      new Response('value'),
      'test',
      (task) => { scheduled = task },
    )

    expect(scheduled).toBeDefined()
    expect(cache.put).toHaveBeenCalledTimes(1)
    finishWrite()
    await scheduled
  })

  it('falls back safely when the scheduler is unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const cache = { put: vi.fn(async () => undefined) } as unknown as Cache

    await expect(cachePutFailOpen(
      cache,
      new Request('https://cache.invalid/fallback'),
      new Response('value'),
      'test',
      () => { throw new Error('no execution context') },
    )).resolves.toBeUndefined()

    expect(cache.put).toHaveBeenCalledTimes(1)
  })
})
