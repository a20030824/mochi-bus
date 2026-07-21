import type { TelemetryTdxOperation } from '../../observability/telemetry'
import { TDXServiceError } from './error-classification'

export const DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES = 8 * 1024 * 1024
export const TDX_ERROR_MAX_RESPONSE_BYTES = 32 * 1024

export type TDXResponseSizeSource = 'content_length' | 'stream'

export type TDXResponseObservation = {
  operation?: TelemetryTdxOperation | 'token'
  resource: string
  credentialScope: 'shared' | 'byok'
}

export type TDXBoundedTextResponse = {
  text: string
  receivedBytes: number
  declaredBytes?: number
  truncated: boolean
  limitSource?: TDXResponseSizeSource
}

export type TDXParsedJsonResponse = {
  data: unknown
  receivedBytes: number
  declaredBytes?: number
}

export class TDXPayloadTooLargeError extends TDXServiceError {
  constructor(
    readonly maxBytes: number,
    readonly sizeSource: TDXResponseSizeSource,
    readonly receivedBytes?: number,
    readonly declaredBytes?: number,
  ) {
    super('TDX response exceeds configured byte limit', 502, {
      failureKind: 'invalid_schema',
    })
    this.name = 'TDXPayloadTooLargeError'
  }
}

// Bounded response ownership lives here. Request loops still decide how parse/size failures affect
// retries and circuits; this boundary only reads, measures, truncates and emits identity-safe size logs.
export function normalizedResponseByteLimit(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined
}

export function responseByteLimit(value: number | undefined): number {
  return normalizedResponseByteLimit(value) ?? DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES
}

export async function readJsonResponse(
  response: Response,
  maxBytes = DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES,
): Promise<TDXParsedJsonResponse> {
  const body = await readTextResponse(response, maxBytes, false)
  return {
    data: JSON.parse(body.text),
    receivedBytes: body.receivedBytes,
    declaredBytes: body.declaredBytes,
  }
}

export async function readTextResponse(
  response: Response,
  maxBytes: number,
  truncateOnLimit: boolean,
): Promise<TDXBoundedTextResponse> {
  const safeMaxBytes = Math.max(1, Math.floor(maxBytes))
  const declaredLength = parsedContentLength(response.headers.get('Content-Length'))
  if (!truncateOnLimit && declaredLength !== undefined && declaredLength > safeMaxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new TDXPayloadTooLargeError(safeMaxBytes, 'content_length', undefined, declaredLength)
  }
  if (!response.body) {
    return { text: '', receivedBytes: 0, declaredBytes: declaredLength, truncated: false }
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let receivedBytes = 0
  let body = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue

      const remainingBytes = safeMaxBytes - receivedBytes
      if (value.byteLength > remainingBytes) {
        if (remainingBytes > 0) {
          body += decoder.decode(value.subarray(0, remainingBytes), { stream: true })
        }
        receivedBytes += value.byteLength
        await reader.cancel().catch(() => undefined)
        if (!truncateOnLimit) {
          throw new TDXPayloadTooLargeError(safeMaxBytes, 'stream', receivedBytes, declaredLength)
        }
        body += decoder.decode()
        return {
          text: body,
          receivedBytes,
          declaredBytes: declaredLength,
          truncated: true,
          limitSource: declaredLength !== undefined && declaredLength > safeMaxBytes
            ? 'content_length'
            : 'stream',
        }
      }

      receivedBytes += value.byteLength
      body += decoder.decode(value, { stream: true })
    }
    body += decoder.decode()
    return { text: body, receivedBytes, declaredBytes: declaredLength, truncated: false }
  } finally {
    reader.releaseLock()
  }
}

export function logTDXResponseTooLarge(
  error: TDXPayloadTooLargeError,
  observation: TDXResponseObservation,
): void {
  console.error(JSON.stringify({
    message: 'tdx_response_too_large',
    operation: observation.operation ?? 'unclassified',
    resource: observation.resource,
    credentialScope: observation.credentialScope,
    maxBytes: error.maxBytes,
    receivedBytes: error.receivedBytes ?? null,
    declaredBytes: error.declaredBytes ?? null,
    sizeSource: error.sizeSource,
  }))
}

export function logTDXResponseSize(
  observation: TDXResponseObservation & {
    maxBytes: number
    receivedBytes: number
    declaredBytes?: number
    sampled: boolean
  },
): void {
  const nearLimit = observation.receivedBytes * 4 >= observation.maxBytes * 3
  if (!observation.sampled && !nearLimit) return
  console.info(JSON.stringify({
    message: 'tdx_response_size_observed',
    sampleReason: nearLimit ? 'near_limit' : 'sampled',
    operation: observation.operation ?? 'unclassified',
    resource: observation.resource,
    credentialScope: observation.credentialScope,
    maxBytes: observation.maxBytes,
    receivedBytes: observation.receivedBytes,
    declaredBytes: observation.declaredBytes ?? null,
    sizeBucket: responseSizeBucket(observation.receivedBytes),
    limitUsageBucket: responseLimitUsageBucket(observation.receivedBytes, observation.maxBytes),
  }))
}

export function responseSizeBucket(bytes: number): string {
  if (bytes < 64 * 1024) return 'lt_64k'
  if (bytes < 256 * 1024) return '64k_256k'
  if (bytes < 512 * 1024) return '256k_512k'
  if (bytes < 1024 * 1024) return '512k_1m'
  if (bytes < 2 * 1024 * 1024) return '1m_2m'
  if (bytes < 4 * 1024 * 1024) return '2m_4m'
  if (bytes < 8 * 1024 * 1024) return '4m_8m'
  return 'gte_8m'
}

export function responseLimitUsageBucket(bytes: number, maxBytes: number): string {
  const ratio = bytes / Math.max(1, maxBytes)
  if (ratio < 0.25) return 'lt_25pct'
  if (ratio < 0.5) return '25_50pct'
  if (ratio < 0.75) return '50_75pct'
  if (ratio < 0.9) return '75_90pct'
  if (ratio < 1) return '90_100pct'
  return 'gte_100pct'
}

export function parsedContentLength(value: string | null): number | undefined {
  if (!value) return undefined
  const length = Number(value)
  return Number.isFinite(length) && length >= 0 ? length : undefined
}
