import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertRedacted, fetchRawBundle, parseRetryAfter, parseVars, replayRawBundle, safeErrorRecord } from './tdx-source.mjs'

describe('TDX source safety and replay', () => {
  it('parses ignored .dev.vars syntax without accepting CLI secrets', () => {
    expect(parseVars('TDX_CLIENT_ID="id"\nexport TDX_CLIENT_SECRET=secret\n')).toEqual({ TDX_CLIENT_ID: 'id', TDX_CLIENT_SECRET: 'secret' })
  })

  it('parses Retry-After seconds and HTTP dates', () => {
    const now = new Date('2026-07-23T00:00:00Z')
    expect(parseRetryAfter('2', now)).toBe(2000)
    expect(parseRetryAfter('Thu, 23 Jul 2026 00:00:03 GMT', now)).toBe(3000)
    expect(parseRetryAfter(null, now)).toBeNull()
  })

  it('writes a hash-checked cache and replays without network requests', async () => {
    const rawDir = await mkdtemp(join(tmpdir(), 'tdx-measurement-'))
    const fetcher = vi.fn(async (url) => {
      if (String(url).includes('/token')) return new Response(JSON.stringify({ access_token: 'token' }), { status: 200 })
      if (String(url).includes('StopOfRoute')) return new Response(JSON.stringify([]), { status: 200 })
      return new Response(JSON.stringify([]), { status: 200 })
    })
    try {
      const live = await fetchRawBundle({
        cities: ['Taipei'], includeIntercity: false, rawDir, concurrency: 1, fetcher,
        credentials: { clientId: 'client-id', clientSecret: 'client-secret' }, progress: () => undefined,
        random: () => 0,
      })
      expect(live.manifest.endpoints).toHaveLength(2)
      fetcher.mockClear()
      const replay = await replayRawBundle({ rawDir })
      expect(fetcher).not.toHaveBeenCalled()
      expect(replay.bundle).toEqual(live.bundle)
      const serialized = await readFile(join(rawDir, 'manifest.json'), 'utf8')
      expect(serialized).not.toContain('client-secret')
      expect(serialized).not.toContain('Authorization')
    } finally {
      await rm(rawDir, { recursive: true, force: true })
    }
  })

  it('fails closed on a corrupted cache', async () => {
    const rawDir = await mkdtemp(join(tmpdir(), 'tdx-corrupt-'))
    try {
      await fetchRawBundle({
        cities: ['Taipei'], includeIntercity: false, rawDir, concurrency: 1,
        fetcher: async (url) => String(url).includes('/token')
          ? new Response(JSON.stringify({ access_token: 'token' }), { status: 200 })
          : new Response(JSON.stringify([]), { status: 200 }),
        credentials: { clientId: 'id', clientSecret: 'secret' }, progress: () => undefined,
      })
      const manifest = JSON.parse(await readFile(join(rawDir, 'manifest.json'), 'utf8'))
      await import('node:fs/promises').then(({ writeFile }) => writeFile(join(rawDir, manifest.endpoints[0].fileName), '[{"tampered":true}]'))
      await expect(replayRawBundle({ rawDir })).rejects.toMatchObject({ details: { failureClass: 'corrupt_cache' } })
    } finally {
      await rm(rawDir, { recursive: true, force: true })
    }
  })

  it('keeps error records bounded and rejects secret-bearing output', () => {
    const record = safeErrorRecord(new Error('Authorization Bearer secret-body'))
    expect(record).toEqual(expect.objectContaining({ failureClass: 'unexpected' }))
    expect(JSON.stringify(record)).not.toContain('secret-body')
    expect(() => assertRedacted({ header: 'Authorization' }, ['client-id'])).toThrow()
  })
})
