import { describe, expect, it, vi } from 'vitest'
import {
  assertLegacyPreviousRepairPostflight,
  assertLegacyPreviousRepairPreflight,
  runLegacyPreviousRepairPostflight,
  runLegacyPreviousRepairPreflight,
  validateLegacyPreviousRepairRequest,
} from './repair-legacy-previous.mjs'

const expected = Object.freeze({
  city: 'Chiayi',
  expectedActive: '20260720T204100504Z',
  expectedPrevious: '20260713T203452670Z',
})

const preflightRow = Object.freeze({
  active_version: expected.expectedActive,
  previous_version: expected.expectedPrevious,
  active_probe_result: 'degraded',
  probe_failure_class: 'previous_unavailable',
  rollback_available: 0,
  hard_checks_passed: 11,
  diagnostic_warnings: '["previous_unavailable"]',
  d1_active: expected.expectedActive,
})

const postflightRow = Object.freeze({
  result: 'published',
  window_active: '20260722T081530978Z',
  window_previous: expected.expectedActive,
  failure_class: 'none',
  run_kind: 'manual',
  force_publish: 1,
  active_probe_result: 'success',
  probe_failure_class: 'none',
  rollback_available: 1,
  probe_active: '20260722T081530978Z',
  probe_previous: expected.expectedActive,
  hard_checks_passed: 11,
  diagnostic_warnings: '[]',
  d1_active: '20260722T081530978Z',
})

describe('legacy previous repair request', () => {
  it('requires one city, exact versions, force publish, and a manual window', () => {
    expect(validateLegacyPreviousRepairRequest({
      ...expected,
      forcePublish: true,
      windowType: 'manual',
    })).toEqual(expected)

    expect(() => validateLegacyPreviousRepairRequest({
      ...expected,
      city: 'Chiayi Keelung',
      forcePublish: true,
      windowType: 'manual',
    })).toThrow('requires one city')
    expect(() => validateLegacyPreviousRepairRequest({
      ...expected,
      expectedActive: 'main',
      forcePublish: true,
      windowType: 'manual',
    })).toThrow('expected active version is invalid')
    expect(() => validateLegacyPreviousRepairRequest({
      ...expected,
      expectedPrevious: expected.expectedActive,
      forcePublish: true,
      windowType: 'manual',
    })).toThrow('versions must differ')
    expect(() => validateLegacyPreviousRepairRequest({
      ...expected,
      forcePublish: false,
      windowType: 'manual',
    })).toThrow('requires force publish')
    expect(() => validateLegacyPreviousRepairRequest({
      ...expected,
      forcePublish: true,
      windowType: 'scheduled',
    })).toThrow('requires a manual window')
  })
})

describe('legacy previous repair evidence', () => {
  it('accepts only the exact degraded preflight state', () => {
    expect(assertLegacyPreviousRepairPreflight([preflightRow], expected)).toEqual({
      city: 'Chiayi',
      activeVersion: expected.expectedActive,
      previousVersion: expected.expectedPrevious,
    })
    expect(() => assertLegacyPreviousRepairPreflight([{
      ...preflightRow,
      hard_checks_passed: 10,
    }], expected)).toThrow('preflight state changed')
    expect(() => assertLegacyPreviousRepairPreflight([{
      ...preflightRow,
      diagnostic_warnings: '["previous_unavailable","shape_sample_unavailable"]',
    }], expected)).toThrow('preflight state changed')
  })

  it('accepts only a new healthy active with the old active retained as previous', () => {
    expect(assertLegacyPreviousRepairPostflight(
      [postflightRow],
      expected,
      'v1:Chiayi:2026-07-22:manual',
    )).toEqual({
      city: 'Chiayi',
      windowId: 'v1:Chiayi:2026-07-22:manual',
      previousActive: expected.expectedActive,
      newActive: '20260722T081530978Z',
      hardChecksPassed: 11,
      rollbackAvailable: true,
    })
    expect(() => assertLegacyPreviousRepairPostflight([{
      ...postflightRow,
      rollback_available: 0,
    }], expected, 'v1:Chiayi:2026-07-22:manual')).toThrow('postflight verification failed')
    expect(() => assertLegacyPreviousRepairPostflight([{
      ...postflightRow,
      window_active: expected.expectedActive,
      probe_active: expected.expectedActive,
      d1_active: expected.expectedActive,
    }], expected, 'v1:Chiayi:2026-07-22:manual')).toThrow('postflight verification failed')
  })

  it('rejects incomplete or malformed durable evidence', () => {
    expect(() => assertLegacyPreviousRepairPreflight([], expected)).toThrow('evidence is incomplete')
    expect(() => assertLegacyPreviousRepairPreflight([{
      ...preflightRow,
      diagnostic_warnings: 'not-json',
    }], expected)).toThrow('warnings are invalid')
  })
})

describe('legacy previous repair D1 queries', () => {
  it('uses bound city parameters for preflight', async () => {
    const fetchImpl = d1Fetch([preflightRow])
    await expect(runLegacyPreviousRepairPreflight({
      ...expected,
      accountId: 'account',
      apiToken: 'token',
      fetchImpl,
    })).resolves.toEqual({
      city: 'Chiayi',
      activeVersion: expected.expectedActive,
      previousVersion: expected.expectedPrevious,
    })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params).toEqual(['Chiayi'])
  })

  it('uses the exact manual window for postflight', async () => {
    const fetchImpl = d1Fetch([postflightRow])
    await expect(runLegacyPreviousRepairPostflight({
      ...expected,
      windowDate: '2026-07-22',
      accountId: 'account',
      apiToken: 'token',
      fetchImpl,
    })).resolves.toMatchObject({
      windowId: 'v1:Chiayi:2026-07-22:manual',
      newActive: '20260722T081530978Z',
    })
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body).params).toEqual([
      'Chiayi',
      'v1:Chiayi:2026-07-22:manual',
    ])
  })
})

function d1Fetch(results) {
  return vi.fn(async () => new Response(JSON.stringify({
    success: true,
    result: [{ success: true, results }],
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))
}
