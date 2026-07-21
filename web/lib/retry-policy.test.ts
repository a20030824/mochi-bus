import { describe, expect, it } from 'vitest'
import { MochiApiError } from '../tdx/api-client'
import {
  placeRetryDecision,
  routeRetryDecision,
  routeWarningRetryDecision,
  shouldRevealPlaceFailure,
} from './retry-policy'

describe('retry policy', () => {
  it('uses a quiet 3 second first Place retry, then 30 and 60 seconds', () => {
    const error = new TypeError('offline')
    expect(placeRetryDecision(error, 1)).toEqual({ retry: true, delayMs: 3_000 })
    expect(placeRetryDecision(error, 2)).toEqual({ retry: true, delayMs: 30_000 })
    expect(placeRetryDecision(error, 3)).toEqual({ retry: true, delayMs: 60_000 })
    expect(placeRetryDecision(error, 8)).toEqual({ retry: true, delayMs: 60_000 })
    expect(shouldRevealPlaceFailure(1)).toBe(false)
    expect(shouldRevealPlaceFailure(2)).toBe(true)
  })

  it('uses Retry-After ahead of local fallback delays', () => {
    const error = new MochiApiError('busy', 429, undefined, 17_000)
    expect(routeRetryDecision(error)).toEqual({ retry: true, delayMs: 17_000 })
    expect(placeRetryDecision(error, 1)).toEqual({ retry: true, delayMs: 17_000 })
  })

  it('uses 30 seconds for Route transient failures and five minutes for quota', () => {
    expect(routeRetryDecision(new TypeError('offline'))).toEqual({ retry: true, delayMs: 30_000 })
    expect(routeWarningRetryDecision('tdx-rate-limit')).toEqual({ retry: true, delayMs: 30_000 })
    expect(routeWarningRetryDecision('tdx-unavailable')).toEqual({ retry: true, delayMs: 30_000 })
    expect(routeWarningRetryDecision('tdx-quota')).toEqual({ retry: true, delayMs: 300_000 })
  })

  it('does not retry permanent client, invariant-like, or rejected-token failures', () => {
    expect(routeRetryDecision(new Error('malformed response'))).toEqual({ retry: false })
    expect(routeRetryDecision(new MochiApiError('bad request', 400))).toEqual({ retry: false })
    expect(placeRetryDecision(new MochiApiError('rejected', 401, 'tdx_access_token_rejected'), 1))
      .toEqual({ retry: false })
  })
})
