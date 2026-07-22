import { describe, expect, it, vi } from 'vitest'
import { ReleaseSmokeError, runPostDeploySmoke } from './post-deploy.mjs'

const expectedSha = '0123456789abcdef0123456789abcdef01234567'
const release = {
  schemaVersion: 1,
  releaseSha: expectedSha,
  workerVersionId: 'worker-version-1',
  workerCreatedAt: '2026-07-22T16:30:00.000Z',
}

describe('release propagation polling', () => {
  it('retries a transient release-endpoint read failure inside the propagation timeout', async () => {
    let clock = 0
    const readRelease = vi.fn()
      .mockRejectedValueOnce(new ReleaseSmokeError('release_observation_failed'))
      .mockResolvedValue(release)

    await expect(runPostDeploySmoke({
      expectedSha,
      readRelease,
      probeHttp: vi.fn(async ({ phase }) => ({ phase })),
      probeBrowser: vi.fn(async () => ({ pages: 3, pageErrors: 0, consoleErrors: 0, chunkFailures: 0 })),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      propagationTimeoutMs: 2_000,
      pollIntervalMs: 500,
      observationWindowMs: 0,
      observationIntervalMs: 500,
    })).resolves.toMatchObject({ result: 'success', releaseSha: expectedSha })

    expect(readRelease).toHaveBeenCalledTimes(2)
    expect(clock).toBe(500)
  })

  it('does not retry a structurally invalid release document', async () => {
    let clock = 0
    const readRelease = vi.fn(async () => ({ ...release, workerVersionId: null }))

    await expect(runPostDeploySmoke({
      expectedSha,
      readRelease,
      probeHttp: vi.fn(),
      probeBrowser: vi.fn(),
      now: () => clock,
      sleep: async (milliseconds) => { clock += milliseconds },
      propagationTimeoutMs: 2_000,
      pollIntervalMs: 500,
      observationWindowMs: 0,
      observationIntervalMs: 500,
    })).rejects.toMatchObject({ code: 'release_identity_invalid' })

    expect(readRelease).toHaveBeenCalledTimes(1)
    expect(clock).toBe(0)
  })
})
