import type { TDXWarning } from '../../domain/tdx-warning'
import type { TelemetryFailureClass } from '../../observability/telemetry'

// This boundary owns error identity, warning/failure classification, and shared-quota state.
// The TDX client remains responsible for bounded response reads, safe logging, retries, and circuits.
const QUOTA_SUSPECT_AFTER_MS = 10 * 60 * 1000

let sharedRateLimitedSince: number | null = null

export class TDXServiceError extends Error {
  warning?: TDXWarning
  failureKind?: TelemetryFailureClass

  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions & { failureKind?: TelemetryFailureClass },
  ) {
    super(message, options)
    this.name = 'TDXServiceError'
    this.failureKind = options?.failureKind
  }

  get rateLimited(): boolean {
    return this.status === 429 || this.warning === 'tdx-rate-limit' || this.warning === 'tdx-quota'
  }
}

export function isRejectedUserTdxToken(error: unknown, authorization?: string): boolean {
  return Boolean(authorization)
    && error instanceof TDXServiceError
    && error.status === 401
}

export function classifyTDXWarning(status: number, body: string): TDXWarning | undefined {
  const text = body.toLowerCase()
  const quotaLike = /quota|quotas|monthly|usage|額度|配額|用量|用完|用盡/.test(text)
    || (/exceed|exceeded|exceeds|超過|超出/.test(text)
      && /limit|limited|限制|上限/.test(text)
      && !/rate|frequency|頻率/.test(text))
    // 額度用完時 TDX 可能讓整個 App 停權，連 token 端點都回 OAuth credential error。
    || /unauthorized_client|invalid_client|invalid client credentials/.test(text)
  if (quotaLike) return 'tdx-quota'

  if (status !== 429 && /rate.?limit|too many requests|frequency|頻率|請求過多/.test(text)) {
    return 'tdx-rate-limit'
  }

  return undefined
}

export function responseFailureClass(status: number, warning?: TDXWarning): TelemetryFailureClass {
  if (warning === 'tdx-quota') return 'quota'
  if (status === 429 || warning === 'tdx-rate-limit') return 'rate_limited'
  if (status === 401) return 'token_rejected'
  if (status >= 400 && status <= 499) return 'upstream_4xx'
  if (status >= 500 && status <= 599) return 'upstream_5xx'
  return 'unknown'
}

export function transportFailureClass(error: unknown): TelemetryFailureClass {
  const name = error instanceof Error ? error.name : ''
  return name === 'AbortError' || name === 'TimeoutError' ? 'timeout' : 'network_error'
}

export function observeTDXResponseFailure(
  status: number,
  warning: TDXWarning | undefined,
  isShared: boolean,
  now = Date.now(),
): void {
  if (!isShared) return
  if (status !== 429 && warning !== 'tdx-rate-limit' && warning !== 'tdx-quota') return
  sharedRateLimitedSince ??= now
}

export function observeTDXResponseSuccess(isShared: boolean): void {
  if (isShared) sharedRateLimitedSince = null
}

export function tdxWarningFromError(error: unknown, now = Date.now()): TDXWarning | undefined {
  if (!(error instanceof TDXServiceError)) return undefined
  if (error.warning) return error.warning
  if (!error.rateLimited) return 'tdx-unavailable'
  return sharedRateLimitedSince !== null && now - sharedRateLimitedSince >= QUOTA_SUSPECT_AFTER_MS
    ? 'tdx-quota'
    : 'tdx-rate-limit'
}

// 測試與 Worker isolate reset 共用：清掉跨請求／跨案例的共用 429 追蹤狀態。
export function resetTDXRateLimitTracking(): void {
  sharedRateLimitedSince = null
}

export function asTDXServiceError(error: unknown): TDXServiceError {
  if (error instanceof TDXServiceError) return error
  return new TDXServiceError('TDX resolution failed', undefined, {
    cause: error,
    failureKind: 'unknown',
  })
}
