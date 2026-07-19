import { describe, expect, it } from 'vitest'
import {
  DEFAULT_JSON_READ_LIMIT,
  MAX_MANIFEST_READ_LIMIT,
  manifestReadLimit,
} from './manifest-read-limit.mjs'

describe('snapshot manifest remote read limit', () => {
  it('keeps the existing one MiB floor for small JSON objects', () => {
    expect(manifestReadLimit({ schemaVersion: 2, artifacts: [] })).toBe(DEFAULT_JSON_READ_LIMIT)
  })

  it('scales above one MiB from the locally generated expected manifest size', () => {
    const manifest = { schemaVersion: 2, artifacts: [{ key: 'x'.repeat(1_100_000) }] }
    const expectedBytes = Buffer.byteLength(JSON.stringify(manifest))
    const limit = manifestReadLimit(manifest)
    expect(limit).toBeGreaterThan(expectedBytes)
    expect(limit).toBeGreaterThan(DEFAULT_JSON_READ_LIMIT)
    expect(limit - expectedBytes).toBe(64 * 1024)
  })

  it('rejects manifests that would exceed the absolute safety ceiling', () => {
    const manifest = { schemaVersion: 2, artifacts: [{ key: 'x'.repeat(MAX_MANIFEST_READ_LIMIT) }] }
    expect(() => manifestReadLimit(manifest)).toThrow('Snapshot manifest exceeds the remote validation safety limit')
  })
})
