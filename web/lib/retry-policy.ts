import { MochiApiError, isTdxTokenRejectedError } from '../tdx/api-client'

const DEFAULT_TRANSIENT_DELAY_MS = 30_000
const QUOTA_DELAY_MS = 5 * 60_000
const DRAWER_DELAYS_MS = [3_000, 30_000, 60_000] as const

export type RetryDecision =
  | { retry: false }
  | { retry: true; delayMs: number }

export function routeRetryDecision(error: unknown): RetryDecision {
  if (isPermanentFailure(error)) return { retry: false }
  if (isQuotaFailure(error)) return { retry: true, delayMs: QUOTA_DELAY_MS }
  return {
    retry: true,
    delayMs: retryAfterMs(error) ?? DEFAULT_TRANSIENT_DELAY_MS,
  }
}

export function drawerRetryDecision(error: unknown, consecutiveFailures: number): RetryDecision {
  if (isPermanentFailure(error)) return { retry: false }
  if (isQuotaFailure(error)) return { retry: true, delayMs: QUOTA_DELAY_MS }
  return {
    retry: true,
    delayMs: retryAfterMs(error) ?? drawerDelay(consecutiveFailures),
  }
}

export function shouldRevealDrawerFailure(consecutiveFailures: number): boolean {
  return consecutiveFailures >= 2
}

function drawerDelay(consecutiveFailures: number): number {
  const index = Math.min(Math.max(consecutiveFailures, 1), DRAWER_DELAYS_MS.length) - 1
  return DRAWER_DELAYS_MS[index]
}

function isPermanentFailure(error: unknown): boolean {
  if (isTdxTokenRejectedError(error)) return true
  return error instanceof MochiApiError && error.status >= 400 && error.status < 500 && error.status !== 429
}

function isQuotaFailure(error: unknown): boolean {
  return error instanceof MochiApiError && error.code === 'tdx-quota'
}

function retryAfterMs(error: unknown): number | undefined {
  if (!(error instanceof MochiApiError)) return undefined
  return error.retryAfterMs
}
