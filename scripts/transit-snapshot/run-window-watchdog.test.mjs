import { describe, expect, it, vi } from 'vitest'
import { evaluateWindowWatchdog } from './watchdog-contract.mjs'
import { runWindowWatchdog, watchdogSummaryMarkdown } from './run-window-watchdog.mjs'

const evaluatedAt = '2026-07-19T23:45:00.000Z'

function evidence(city, overrides = {}) {
  const windowId = `v1:${city}:2026-07-20:0317`
  return {
    window: {
      schemaVersion: 1,
      city,
      windowId,
      completedAt: '2026-07-19T19:29:00.000Z',
      result: 'unchanged',
      lastSourceCheckAt: '2026-07-19T19:20:00.000Z',
      lastPublishedAt: '2026-07-12T19:27:00.000Z',
      activeVersion: `${city}-v1`,
      previousVersion: `${city}-v0`,
      failureClass: 'none',
    },
    sameWindowProbe: {
      probeSchemaVersion: 1,
      city,
      windowId,
      activeVersion: `${city}-v1`,
      previousVersion: `${city}-v0`,
      activeProbeAt: '2026-07-19T19:26:00.000Z',
      activeProbeResult: 'success',
      probeFailureClass: 'none',
      rollbackAvailable: true,
    },
    latestUsableProbe: null,
    attemptSummary: { attemptCount: 1, incompleteAttemptCount: 0 },
    recordWriteFailure: false,
    ...overrides,
  }
}

function store(overrides = {}) {
  return {
    startRun: vi.fn(async () => undefined),
    readEvidence: vi.fn(async (city) => evidence(city)),
    completeCity: vi.fn(async () => undefined),
    completeRun: vi.fn(async () => undefined),
    ...overrides,
  }
}

function fixedClock() {
  return () => new Date(evaluatedAt)
}

function monotonicClock() {
  let value = 0
  return () => (value += 10)
}

describe('window watchdog runner', () => {
  it('evaluates every expected city and succeeds only for healthy statuses', async () => {
    const target = store()
    const emitter = vi.fn()
    const result = await runWindowWatchdog({
      env: { GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '1' },
      now: fixedClock(), monotonic: monotonicClock(), store: target, emitter, summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(true)
    expect(result.summary.results.map((item) => [item.city, item.status])).toEqual([
      ['Taipei', 'unchanged_healthy'],
      ['NewTaipei', 'unchanged_healthy'],
    ])
    expect(target.readEvidence).toHaveBeenCalledTimes(2)
    expect(target.completeCity).toHaveBeenCalledTimes(2)
    expect(emitter).toHaveBeenCalledTimes(2)
  })

  it('does not let one city query failure prevent the remaining cities', async () => {
    const target = store({
      readEvidence: vi.fn(async (city) => {
        if (city === 'Taipei') throw new Error('private database detail')
        return evidence(city)
      }),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })

    expect(result.ok).toBe(false)
    expect(result.failedCities).toEqual(['Taipei'])
    expect(result.summary.results).toHaveLength(2)
    expect(result.summary.results[0]).toMatchObject({ status: 'unknown', diagnosticClass: 'watchdog_query_failed' })
    expect(result.summary.results[1]).toMatchObject({ city: 'NewTaipei', status: 'unchanged_healthy' })
  })

  it('reports city durable-write failure without modifying snapshot state', async () => {
    const target = store({
      completeCity: vi.fn(async (_runId, result) => {
        if (result.city === 'Taipei') throw new Error('D1 write unavailable')
      }),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })

    expect(result.summary.results[0]).toMatchObject({
      city: 'Taipei', status: 'record_write_failed', diagnosticClass: 'record_write_failed',
    })
    expect(result.ok).toBe(false)
    expect(target).not.toHaveProperty('activate')
    expect(target).not.toHaveProperty('writeR2')
  })

  it('keeps city evaluation independent when telemetry emission fails', async () => {
    const target = store()
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: () => { throw new Error('logs unavailable') }, summaryWriter: vi.fn(),
    })
    expect(result.ok).toBe(true)
    expect(target.completeCity).toHaveBeenCalledTimes(2)
  })

  it('fails the job for rollback degraded while saying current service remains usable', async () => {
    const target = store({
      readEvidence: vi.fn(async (city) => evidence(city, {
        sameWindowProbe: {
          ...evidence(city).sameWindowProbe,
          activeProbeResult: 'degraded',
          probeFailureClass: 'previous_unavailable',
          rollbackAvailable: false,
        },
      })),
    })
    const result = await runWindowWatchdog({
      now: fixedClock(), monotonic: monotonicClock(), store: target,
      emitter: vi.fn(), summaryWriter: vi.fn(),
    })
    const markdown = watchdogSummaryMarkdown(result.summary)
    expect(result.ok).toBe(false)
    expect(markdown).toContain('- Rollback degraded: Taipei, NewTaipei')
    expect(markdown).toContain('unchanged_rollback_degraded')
  })

  it('renders only fixed safe summary fields', () => {
    const result = evaluateWindowWatchdog({
      city: 'Taipei', scheduleDate: '2026-07-20', evaluatedAt,
      ...evidence('Taipei'),
    })
    const markdown = watchdogSummaryMarkdown({ scheduleDate: '2026-07-20', evaluatedAt, results: [result] })
    expect(markdown).toContain('| Taipei | v1:Taipei:2026-07-20:0317 | unchanged_healthy |')
    expect(markdown).not.toMatch(/route|place|artifact|https?:|authorization|token|stack|raw error/i)
  })
})
