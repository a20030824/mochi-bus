import { describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_JSON_READ_LIMIT,
  MAX_MANIFEST_READ_LIMIT,
  manifestReadLimit,
  manifestReadLimitFromBytes,
  readManifestJson,
} from './manifest-read-limit.mjs'

describe('snapshot manifest remote read limit', () => {
  it('keeps the one MiB floor and scales from object size', () => {
    expect(manifestReadLimit({ schemaVersion: 2, artifacts: [] })).toBe(DEFAULT_JSON_READ_LIMIT)
    expect(manifestReadLimitFromBytes(1_100_000)).toBe(1_100_000 + 64 * 1024)
  })

  it('uses HEAD metadata for active probe reads', async () => {
    const getJson = vi.fn(async () => ({ schemaVersion: 2 }))
    await expect(readManifestJson({
      key: 'manifest.json',
      head: vi.fn(async () => ({ size: 1_100_000 })),
      getJson,
    })).resolves.toEqual({ schemaVersion: 2 })
    expect(getJson).toHaveBeenCalledWith('manifest.json', 1_100_000 + 64 * 1024)
  })

  it.each([
    ['zero', { size: 0 }],
    ['null', { size: null }],
    ['missing', {}],
  ])('uses the absolute bounded fallback when HEAD size is %s', async (_label, metadata) => {
    const getJson = vi.fn(async () => ({ schemaVersion: 2 }))
    await expect(readManifestJson({
      key: 'manifest.json',
      head: vi.fn(async () => metadata),
      getJson,
    })).resolves.toEqual({ schemaVersion: 2 })
    expect(getJson).toHaveBeenCalledWith('manifest.json', MAX_MANIFEST_READ_LIMIT)
  })

  it('returns null only for a missing object', async () => {
    const getJson = vi.fn()
    await expect(readManifestJson({
      key: 'manifest.json',
      head: vi.fn(async () => null),
      getJson,
    })).resolves.toBeNull()
    expect(getJson).not.toHaveBeenCalled()
  })

  it('fails closed for unavailable or oversized explicit sizes', () => {
    expect(() => manifestReadLimitFromBytes(Number.NaN)).toThrow('Snapshot manifest size is unavailable')
    expect(manifestReadLimitFromBytes(MAX_MANIFEST_READ_LIMIT)).toBe(MAX_MANIFEST_READ_LIMIT)
    expect(() => manifestReadLimitFromBytes(MAX_MANIFEST_READ_LIMIT + 1))
      .toThrow('Snapshot manifest exceeds the remote validation safety limit')
  })
})
