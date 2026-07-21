import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES,
  TDXPayloadTooLargeError,
  logTDXResponseSize,
  logTDXResponseTooLarge,
  normalizedResponseByteLimit,
  parsedContentLength,
  readJsonResponse,
  readTextResponse,
  responseByteLimit,
  responseLimitUsageBucket,
  responseSizeBucket,
} from './bounded-response'

afterEach(() => vi.restoreAllMocks())

describe('TDX bounded responses', () => {
  it('normalizes positive byte limits and falls back to the eight-megabyte default', () => {
    expect(normalizedResponseByteLimit(10.9)).toBe(10)
    expect(normalizedResponseByteLimit(0)).toBeUndefined()
    expect(normalizedResponseByteLimit(-1)).toBeUndefined()
    expect(normalizedResponseByteLimit(Number.POSITIVE_INFINITY)).toBeUndefined()
    expect(normalizedResponseByteLimit(Number.NaN)).toBeUndefined()
    expect(responseByteLimit(undefined)).toBe(DEFAULT_TDX_JSON_MAX_RESPONSE_BYTES)
    expect(responseByteLimit(2048.9)).toBe(2048)
  })

  it('rejects oversized Content-Length before reading and cancels the body', async () => {
    let cancelCount = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      cancel() {
        cancelCount += 1
      },
    }), {
      headers: { 'Content-Length': '4096' },
    })

    const promise = readJsonResponse(response, 1024)
    await expect(promise).rejects.toMatchObject({
      name: 'TDXPayloadTooLargeError',
      maxBytes: 1024,
      sizeSource: 'content_length',
      declaredBytes: 4096,
      receivedBytes: undefined,
      failureKind: 'invalid_schema',
      status: 502,
    })
    expect(cancelCount).toBe(1)
  })

  it('rejects a stream that crosses the limit when Content-Length is absent', async () => {
    const chunk = new TextEncoder().encode('abcdefgh')
    let cancelCount = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelCount += 1
      },
    }))

    await expect(readTextResponse(response, 4, false)).rejects.toMatchObject({
      maxBytes: 4,
      sizeSource: 'stream',
      receivedBytes: 8,
      declaredBytes: undefined,
    })
    expect(cancelCount).toBe(1)
  })

  it('truncates error bodies to the byte cap and records the limit source', async () => {
    const chunk = new TextEncoder().encode('monthly quota exceeded')
    let cancelCount = 0
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk)
      },
      cancel() {
        cancelCount += 1
      },
    }), {
      headers: { 'Content-Length': String(chunk.byteLength) },
    })

    await expect(readTextResponse(response, 7, true)).resolves.toEqual({
      text: 'monthly',
      receivedBytes: chunk.byteLength,
      declaredBytes: chunk.byteLength,
      truncated: true,
      limitSource: 'content_length',
    })
    expect(cancelCount).toBe(1)
  })

  it('parses JSON while preserving received and declared byte counts', async () => {
    const text = JSON.stringify([{ id: 'one' }])
    const bytes = new TextEncoder().encode(text).byteLength
    await expect(readJsonResponse(new Response(text, {
      headers: { 'Content-Length': String(bytes) },
    }))).resolves.toEqual({
      data: [{ id: 'one' }],
      receivedBytes: bytes,
      declaredBytes: bytes,
    })
  })

  it('leaves invalid JSON as a native parse failure for request loops to classify', async () => {
    await expect(readJsonResponse(new Response('{'))).rejects.toBeInstanceOf(SyntaxError)
  })

  it('handles empty bodies and validates Content-Length values', async () => {
    await expect(readTextResponse(new Response(null, {
      headers: { 'Content-Length': '0' },
    }), 16, false)).resolves.toEqual({
      text: '',
      receivedBytes: 0,
      declaredBytes: 0,
      truncated: false,
    })
    expect(parsedContentLength(null)).toBeUndefined()
    expect(parsedContentLength('')).toBeUndefined()
    expect(parsedContentLength('-1')).toBeUndefined()
    expect(parsedContentLength('not-a-number')).toBeUndefined()
    expect(parsedContentLength(' 42 ')).toBe(42)
  })

  it('keeps response-size and limit-usage bucket boundaries stable', () => {
    expect(responseSizeBucket(64 * 1024 - 1)).toBe('lt_64k')
    expect(responseSizeBucket(64 * 1024)).toBe('64k_256k')
    expect(responseSizeBucket(256 * 1024)).toBe('256k_512k')
    expect(responseSizeBucket(512 * 1024)).toBe('512k_1m')
    expect(responseSizeBucket(1024 * 1024)).toBe('1m_2m')
    expect(responseSizeBucket(2 * 1024 * 1024)).toBe('2m_4m')
    expect(responseSizeBucket(4 * 1024 * 1024)).toBe('4m_8m')
    expect(responseSizeBucket(8 * 1024 * 1024)).toBe('gte_8m')

    expect(responseLimitUsageBucket(24, 100)).toBe('lt_25pct')
    expect(responseLimitUsageBucket(25, 100)).toBe('25_50pct')
    expect(responseLimitUsageBucket(50, 100)).toBe('50_75pct')
    expect(responseLimitUsageBucket(75, 100)).toBe('75_90pct')
    expect(responseLimitUsageBucket(90, 100)).toBe('90_100pct')
    expect(responseLimitUsageBucket(100, 100)).toBe('gte_100pct')
  })

  it('logs only sampled or near-limit successful responses', () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined)
    const base = {
      operation: 'vehicle_positions' as const,
      resource: 'Route',
      credentialScope: 'byok' as const,
      maxBytes: 1000,
      declaredBytes: 200,
    }

    logTDXResponseSize({ ...base, receivedBytes: 200, sampled: false })
    expect(info).not.toHaveBeenCalled()

    logTDXResponseSize({ ...base, receivedBytes: 200, sampled: true })
    logTDXResponseSize({ ...base, receivedBytes: 800, sampled: false })
    expect(info).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      message: 'tdx_response_size_observed',
      sampleReason: 'sampled',
      operation: 'vehicle_positions',
      resource: 'Route',
      credentialScope: 'byok',
      sizeBucket: 'lt_64k',
      limitUsageBucket: 'lt_25pct',
    })
    expect(JSON.parse(String(info.mock.calls[1]?.[0]))).toMatchObject({
      sampleReason: 'near_limit',
      limitUsageBucket: '75_90pct',
    })
  })

  it('logs oversized responses without request identity or body content', () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    logTDXResponseTooLarge(
      new TDXPayloadTooLargeError(1024, 'content_length', undefined, 4096),
      { operation: 'token', resource: 'token', credentialScope: 'shared' },
    )

    expect(errorLog).toHaveBeenCalledOnce()
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toEqual({
      message: 'tdx_response_too_large',
      operation: 'token',
      resource: 'token',
      credentialScope: 'shared',
      maxBytes: 1024,
      receivedBytes: null,
      declaredBytes: 4096,
      sizeSource: 'content_length',
    })
  })
})
