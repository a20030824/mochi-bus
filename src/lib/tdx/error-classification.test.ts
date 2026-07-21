import { beforeEach, describe, expect, it } from 'vitest'
import {
  TDXServiceError as FacadeTDXServiceError,
  isRejectedUserTdxToken as facadeIsRejectedUserTdxToken,
  resetTDXRateLimitTracking as facadeResetTDXRateLimitTracking,
  tdxWarningFromError as facadeTDXWarningFromError,
} from '../tdx'
import {
  TDXServiceError,
  asTDXServiceError,
  classifyTDXWarning,
  isRejectedUserTdxToken,
  observeTDXResponseFailure,
  observeTDXResponseSuccess,
  resetTDXRateLimitTracking,
  responseFailureClass,
  tdxWarningFromError,
  transportFailureClass,
} from './error-classification'

describe('TDX error classification boundary', () => {
  beforeEach(() => resetTDXRateLimitTracking())

  it('keeps the legacy façade exports bound to the extracted implementation', () => {
    expect(FacadeTDXServiceError).toBe(TDXServiceError)
    expect(facadeIsRejectedUserTdxToken).toBe(isRejectedUserTdxToken)
    expect(facadeResetTDXRateLimitTracking).toBe(resetTDXRateLimitTracking)
    expect(facadeTDXWarningFromError).toBe(tdxWarningFromError)
  })

  it('recognizes rate-limited service errors and personal-token 401 rejection only', () => {
    const statusLimited = new TDXServiceError('limited', 429)
    const warningLimited = new TDXServiceError('quota', 403)
    warningLimited.warning = 'tdx-quota'

    expect(statusLimited.rateLimited).toBe(true)
    expect(warningLimited.rateLimited).toBe(true)
    expect(new TDXServiceError('unavailable', 503).rateLimited).toBe(false)
    expect(isRejectedUserTdxToken(new TDXServiceError('rejected', 401), 'Bearer user')).toBe(true)
    expect(isRejectedUserTdxToken(new TDXServiceError('shared rejected', 401))).toBe(false)
    expect(isRejectedUserTdxToken(new TDXServiceError('forbidden', 403), 'Bearer user')).toBe(false)
  })

  it('classifies quota and non-429 rate-limit response bodies without exposing body text', () => {
    expect(classifyTDXWarning(403, 'monthly quota exceeded')).toBe('tdx-quota')
    expect(classifyTDXWarning(400, '{"error":"unauthorized_client"}')).toBe('tdx-quota')
    expect(classifyTDXWarning(503, 'request frequency limit reached')).toBe('tdx-rate-limit')
    // Plain 429 remains timer-driven; the body classifier does not guess quota immediately.
    expect(classifyTDXWarning(429, 'too many requests')).toBeUndefined()
    expect(classifyTDXWarning(500, 'upstream unavailable')).toBeUndefined()
  })

  it('maps response failures with warning precedence before HTTP status families', () => {
    expect(responseFailureClass(403, 'tdx-quota')).toBe('quota')
    expect(responseFailureClass(503, 'tdx-rate-limit')).toBe('rate_limited')
    expect(responseFailureClass(429)).toBe('rate_limited')
    expect(responseFailureClass(401)).toBe('token_rejected')
    expect(responseFailureClass(404)).toBe('upstream_4xx')
    expect(responseFailureClass(503)).toBe('upstream_5xx')
    expect(responseFailureClass(302)).toBe('unknown')
  })

  it('separates timeout-like transport failures from network errors', () => {
    expect(transportFailureClass(new DOMException('aborted', 'AbortError'))).toBe('timeout')
    expect(transportFailureClass(new DOMException('timed out', 'TimeoutError'))).toBe('timeout')
    expect(transportFailureClass(new TypeError('network unavailable'))).toBe('network_error')
    expect(transportFailureClass('not an error')).toBe('network_error')
  })

  it('escalates a persistent shared 429 only at the ten-minute boundary', () => {
    const error = new TDXServiceError('limited', 429)
    observeTDXResponseFailure(429, undefined, true, 1_000)

    expect(tdxWarningFromError(error, 600_999)).toBe('tdx-rate-limit')
    expect(tdxWarningFromError(error, 601_000)).toBe('tdx-quota')
  })

  it('does not let BYOK failures contaminate shared quota tracking and resets on shared success', () => {
    const error = new TDXServiceError('limited', 429)
    observeTDXResponseFailure(429, undefined, false, 1_000)
    expect(tdxWarningFromError(error, 901_000)).toBe('tdx-rate-limit')

    observeTDXResponseFailure(429, undefined, true, 1_000)
    expect(tdxWarningFromError(error, 901_000)).toBe('tdx-quota')
    observeTDXResponseSuccess(false)
    expect(tdxWarningFromError(error, 901_000)).toBe('tdx-quota')
    observeTDXResponseSuccess(true)
    expect(tdxWarningFromError(error, 901_000)).toBe('tdx-rate-limit')
  })

  it('preserves explicit warnings and wraps unknown failures with an unknown failure class', () => {
    const explicit = new TDXServiceError('quota response', 403)
    explicit.warning = 'tdx-quota'
    expect(tdxWarningFromError(explicit, 0)).toBe('tdx-quota')
    expect(tdxWarningFromError(new TDXServiceError('unavailable', 503), 0)).toBe('tdx-unavailable')
    expect(tdxWarningFromError(new Error('unrelated'), 0)).toBeUndefined()

    expect(asTDXServiceError(explicit)).toBe(explicit)
    const cause = new Error('unexpected')
    expect(asTDXServiceError(cause)).toMatchObject({
      message: 'TDX resolution failed',
      failureKind: 'unknown',
      cause,
    })
  })
})
