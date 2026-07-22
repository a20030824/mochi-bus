import { describe, expect, it, vi } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import { createWindowWatchdogEvent, evaluateWindowWatchdog } from './watchdog-contract.mjs'
import { runWindowWatchdog, watchdogSummaryMarkdown } from './run-window-watchdog.mjs'

const evaluatedAt = '2026-07-19T23:45:00.000Z'

function publishedEvidence(city) {
  const windowId = `v1:${city}:2026-07-20:0317`
  const activeVersion = `${city}-v2`
  return {
    window: {
      schemaVersion: 1,
      city,
      windowId,
      completedAt: '2026-07-19T20:30:00.000Z',
      result: 'published',
      lastSourceCheckAt: '2026-07-19T20:00:00.000Z',
      lastPublishedAt: '2026-07-19T20:30:00.000Z',
      activeVersion,
      previousVersion: null,
      failureClass: 'none',
    },
    sameWindowProbe: {
      probeSchemaVersion: 1,
      city,
      windowId,
      activeVersion,
      previousVersion: null,
      activeProbeAt: '2026-07-19T20:31:00.000Z',
      activeProbeResult: 'degraded',
      probeFailureClass: 'previous_unavailable',
      rollbackAvailable: false,
    },
    latestUsableProbe: null,
    currentActiveVersion: activeVersion,
    attemptSummary: { attemptCount: 1, incompleteAttemptCount: 0 },
    recordWriteFailure: false,
  }
}

describe('published rollback degradation', () => {
  it('keeps a published active snapshot distinct from unknown when only rollback is unavailable', () => {
    const result = evaluateWindowWatchdog({
      city: 'Taipei',
      scheduleDate: '2026-07-20',
      evaluatedAt,
      ...publishedEvidence('Taipei'),
    })

    expect(result).toMatchObject({
      status: 'published_rollback_degraded',
      windowResult: 'published',
      probeResult: 'degraded',
      rollbackAvailable: false,
      diagnosticClass: 'rollback_unavailable',
      signalAgeBucket: 'same_window',
    })

    const event = createWindowWatchdogEvent(result, '0123456789abcdef0123456789abcdef01234567')
    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      result: 'degraded',
      failureClass: 'rollback_unavailable',
      watchdogStatus: 'published_rollback_degraded',
      windowResult: 'published',
    })
  })

  it('shows the explicit status while retaining the fail-closed job policy', async () => {
    const target = {
      startRun: vi.fn(async () => undefined),
      readEvidence: vi.fn(async (city) => publishedEvidence(city)),
      completeCity: vi.fn(async () => undefined),
      completeRun: vi.fn(async () => undefined),
    }
    const result = await runWindowWatchdog({
      env: { GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1' },
      now: () => new Date(evaluatedAt),
      monotonic: (() => {
        let value = 0
        return () => (value += 10)
      })(),
      store: target,
      emitter: vi.fn(),
      summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(false)
    expect(result.failedCities).toEqual(['Taipei', 'NewTaipei'])
    expect(result.summary.results.map((item) => item.status)).toEqual([
      'published_rollback_degraded',
      'published_rollback_degraded',
    ])

    const markdown = watchdogSummaryMarkdown(result.summary)
    expect(markdown).toContain('- Published rollback degraded: Taipei, NewTaipei')
    expect(markdown).toContain('| Taipei | v1:Taipei:2026-07-20:0317 | published_rollback_degraded |')
    expect(markdown).toContain('- Unknown: none')
    expect(target.completeRun).toHaveBeenCalledWith(expect.objectContaining({
      result: 'failed',
      failureCount: 2,
    }))
  })
})
