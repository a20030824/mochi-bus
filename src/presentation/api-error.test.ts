import { describe, expect, it } from 'vitest'
import { QueryValidationError } from '../domain/bus-query'
import {
  TDX_ACCESS_TOKEN_REJECTED_CODE,
  TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
} from '../domain/tdx-api-error'
import { ApiInputError } from '../lib/api-input'
import {
  QueryResolutionError,
  TDXServiceError,
  tdxWarningMessages,
} from '../lib/tdx'
import {
  presentBusApiError,
  type ApiErrorPresentation,
} from './api-error'

const bearer = 'Bearer expired-personal-token'
const quotaError = new TDXServiceError('TDX quota exhausted', 429)
quotaError.warning = 'tdx-quota'

const cases: Array<{
  name: string
  error: unknown
  authorization?: string
  expected: ApiErrorPresentation
}> = [
  {
    name: 'invalid JSON input',
    error: new ApiInputError(400, 'INVALID_JSON', '請求內容不是有效的 JSON'),
    expected: {
      status: 400,
      body: { error: '請求內容不是有效的 JSON', code: 'INVALID_JSON' },
      shouldLog: false,
    },
  },
  {
    name: 'oversized input',
    error: new ApiInputError(413, 'PAYLOAD_TOO_LARGE', '請求內容過大'),
    expected: {
      status: 413,
      body: { error: '請求內容過大', code: 'PAYLOAD_TOO_LARGE' },
      shouldLog: false,
    },
  },
  {
    name: 'unsupported media type',
    error: new ApiInputError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必須是 application/json'),
    expected: {
      status: 415,
      body: {
        error: 'Content-Type 必須是 application/json',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      },
      shouldLog: false,
    },
  },
  {
    name: 'invalid structured request',
    error: new ApiInputError(422, 'INVALID_REQUEST', 'ETA 查詢內容格式錯誤'),
    expected: {
      status: 422,
      body: { error: 'ETA 查詢內容格式錯誤', code: 'INVALID_REQUEST' },
      shouldLog: false,
    },
  },
  {
    name: 'rejected personal token',
    error: new TDXServiceError('TDX rejected token', 401),
    authorization: bearer,
    expected: {
      status: 401,
      body: {
        code: TDX_ACCESS_TOKEN_REJECTED_CODE,
        error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,
      },
      shouldLog: false,
    },
  },
  {
    name: 'shared credential 401 without personal authorization',
    error: new TDXServiceError('TDX shared credential failed', 401),
    expected: {
      status: 502,
      body: { error: tdxWarningMessages['tdx-unavailable'] },
      shouldLog: true,
    },
  },
  {
    name: 'query validation failure',
    error: new QueryValidationError('不支援的縣市：Moon'),
    expected: {
      status: 400,
      body: { error: '不支援的縣市：Moon' },
      shouldLog: false,
    },
  },
  {
    name: 'query resolution failure',
    error: new QueryResolutionError('找不到符合條件的站牌'),
    expected: {
      status: 404,
      body: { error: '找不到符合條件的站牌' },
      shouldLog: false,
    },
  },
  {
    name: 'TDX rate limit',
    error: new TDXServiceError('TDX rate limited', 429),
    expected: {
      status: 429,
      body: { error: tdxWarningMessages['tdx-rate-limit'] },
      shouldLog: true,
    },
  },
  {
    name: 'TDX quota warning',
    error: quotaError,
    expected: {
      status: 429,
      body: { error: tdxWarningMessages['tdx-quota'] },
      shouldLog: true,
    },
  },
  {
    name: 'general TDX failure',
    error: new TDXServiceError('TDX unavailable', 503),
    expected: {
      status: 502,
      body: { error: tdxWarningMessages['tdx-unavailable'] },
      shouldLog: true,
    },
  },
  {
    name: 'unknown failure',
    error: new Error('unexpected'),
    expected: {
      status: 502,
      body: { error: '暫時無法取得公車資料' },
      shouldLog: true,
    },
  },
]

describe('presentBusApiError', () => {
  it.each(cases)('maps $name to the public API contract', ({ error, authorization, expected }) => {
    expect(presentBusApiError(error, authorization)).toEqual(expected)
  })
})
