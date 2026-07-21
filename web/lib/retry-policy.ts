import type { TDXWarning } from '../../src/domain/tdx-warning'
import { MochiApiError, isTdxTokenRejectedError } from '../tdx/api-client'

const DEFAULT_TRANSIENT_DELAY_MS = 30_000
const QUOTA_DELAY_MS = 5 * 60_000
const PLACE_DELAYS_MS = [3_000, 30_000, 60_000] as const

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number }

export function routeRetryDecision(error: unknown): RetryDecision {
  if (!isRetryableFailure(error)) return { retry: false }
  if (isQuotaFailure(error)) return { retry: true, delayMs: QUOTA_DELAY_MS }
  return {
    retry: true,
    delayMs: retryAfterMs(error) ?? DEFAULT_TRANSIENT_DELAY_MS,
  }
}

export function routeWarningRetryDecision(warning: TDXWarning): RetryDecision {
  return {
    retry: true,
    delayMs: warning === 'tdx-quota' ? QUOTA_DELAY_MS : DEFAULT_TRANSIENT_DELAY_MS,
  }
}

export function placeRetryDecision(error: unknown, consecutiveFailures: number): RetryDecision {
  if (!isRetryableFailure(error)) return { retry: false }
  if (isQuotaFailure(error)) return { retry: true, delayMs: QUOTA_DELAY_MS }
  return {
    retry: true,
    delayMs: retryAfterMs(error) ?? placeDelay(consecutiveFailures),
  }
}

export function shouldRevealPlaceFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= 2
}

function placeDelay(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), PLACE_DELAYS_MS.length) - 1
  return PLACE_DELAYS_MS[index]
}

function isRetryableFailure(error: unknown): boolean {
  if (isTdxTokenRejectedError(error)) return false
  if (error instanceof TypeError) return true
  if (!(error instanceof MochiApiError)) return false
  return error.status === 408 || error.status === 429 || error.status >= 500
}

function isQuotaFailure(error: unknown): boolean {
  return error instanceof MochiApiError && error.code === 'tdx-quota'
}

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof MochiApiError)) return undefined
  return error.retryAfterMs
}
