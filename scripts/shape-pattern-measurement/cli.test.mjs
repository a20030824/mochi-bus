import { describe, expect, it } from 'vitest'
import { parseCli } from './cli.mjs'

describe('measurement CLI validation', () => {
  it.each(['--client-id', '--client-secret', '--token'])('rejects secret flag %s', async (flag) => {
    await expect(parseCli([flag, 'secret'], { requireReplayPath: false })).rejects.toThrow(/forbidden/)
  })

  it('rejects unknown cities, non-finite values, negative values, and directory conflicts', async () => {
    await expect(parseCli(['--cities', 'Unknown'], { requireReplayPath: false })).rejects.toThrow(/Unknown city/)
    await expect(parseCli(['--iterations', 'Infinity'], { requireReplayPath: false })).rejects.toThrow()
    await expect(parseCli(['--warmup', '-1'], { requireReplayPath: false })).rejects.toThrow()
    await expect(parseCli(['--raw-dir', 'same', '--report-dir', 'same'], { requireReplayPath: false })).rejects.toThrow(/distinct/)
  })

  it('requires an explicit expected SHA-256 for instrumented mode', async () => {
    await expect(parseCli(['--instrumented'], { requireReplayPath: false })).rejects.toThrow(/expected-matcher-sha256/)
    await expect(parseCli(['--instrumented', '--expected-matcher-sha256', 'a'.repeat(64)], { requireReplayPath: false }))
      .resolves.toMatchObject({ instrumented: true, expectedMatcherSha256: 'a'.repeat(64) })
  })
})
