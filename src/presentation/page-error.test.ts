import { describe, expect, it } from 'vitest'
import { QueryValidationError } from '../domain/bus-query'
import {
  QueryResolutionError,
  TDXServiceError,
  tdxWarningMessages,
} from '../lib/tdx'
import { presentPageError, type PageErrorPresentation } from './page-error'

const setupUrl = '/setup?city=Taipei&route=307&direction=0&stop=捷運西門站'
const queryActions = [{ href: setupUrl, label: '重新選擇路線與站牌' }]
const serviceActions = [
  { href: '/', label: '回到首頁' },
  { href: '/map', label: '打開地圖' },
]

const quotaError = new TDXServiceError('TDX quota exhausted', 429)
quotaError.warning = 'tdx-quota'

const cases: Array<{
  name: string
  error: unknown
  expected: PageErrorPresentation
}> = [
  {
    name: 'validation failure',
    error: new QueryValidationError('缺少站牌名稱或 StopUID'),
    expected: {
      status: 400,
      title: '找不到這班公車',
      message: '缺少站牌名稱或 StopUID',
      actions: queryActions,
    },
  },
  {
    name: 'query resolution failure',
    error: new QueryResolutionError('找不到這個方向的完整站序'),
    expected: {
      status: 404,
      title: '找不到這班公車',
      message: '找不到這個方向的完整站序',
      actions: queryActions,
    },
  },
  {
    name: 'TDX rate limit',
    error: new TDXServiceError('TDX rate limited', 429),
    expected: {
      status: 429,
      title: '暫時無法取得公車資料',
      message: tdxWarningMessages['tdx-rate-limit'],
      actions: serviceActions,
    },
  },
  {
    name: 'TDX quota warning',
    error: quotaError,
    expected: {
      status: 429,
      title: '暫時無法取得公車資料',
      message: tdxWarningMessages['tdx-quota'],
      actions: serviceActions,
    },
  },
  {
    name: 'general TDX failure',
    error: new TDXServiceError('TDX unavailable', 503),
    expected: {
      status: 503,
      title: '暫時無法取得公車資料',
      message: tdxWarningMessages['tdx-unavailable'],
      actions: serviceActions,
    },
  },
  {
    name: 'unknown failure',
    error: new Error('unexpected'),
    expected: {
      status: 503,
      title: '暫時無法取得公車資料',
      message: '暫時無法取得公車資料',
      actions: serviceActions,
    },
  },
]

describe('presentPageError', () => {
  it.each(cases)('maps $name to the public page contract', ({ error, expected }) => {
    expect(presentPageError(error, setupUrl)).toEqual(expected)
  })
})
