import { describe, expect, it } from 'vitest'
import { QueryValidationError } from '../domain/bus-query'
import { QueryResolutionError, TDXServiceError, tdxWarningMessages } from '../lib/tdx'
import { presentShortcutError, presentShortcutEta } from './shortcut'

describe('presentShortcutEta', () => {
  it('formats a fresh ETA as two compact text lines', () => {
    expect(presentShortcutEta({
      routeName: '307',
      stopName: '捷運西門站',
      label: '5 分鐘',
      stale: false,
    })).toEqual({
      status: 200,
      body: '307｜捷運西門站\n5 分鐘',
      shouldLog: false,
    })
  })

  it('adds the stale warning on its own line', () => {
    expect(presentShortcutEta({
      routeName: '307',
      stopName: '捷運西門站',
      label: '暫無資料',
      stale: true,
    })).toEqual({
      status: 200,
      body: '307｜捷運西門站\n暫無資料\n⚠️ 資料可能延遲',
      shouldLog: false,
    })
  })
})

describe('presentShortcutError', () => {
  it('returns 400 for invalid shortcut queries', () => {
    expect(presentShortcutError(new QueryValidationError('不支援的縣市：Moon'))).toEqual({
      status: 400,
      body: '不支援的縣市：Moon',
      shouldLog: true,
    })
  })

  it('keeps resolution failures on the existing 503 shortcut contract', () => {
    expect(presentShortcutError(new QueryResolutionError('找不到 307 的 捷運西門站'))).toEqual({
      status: 503,
      body: '找不到 307 的 捷運西門站',
      shouldLog: true,
    })
  })

  it('uses the public TDX warning while keeping the shortcut status at 503', () => {
    expect(presentShortcutError(new TDXServiceError('rate limited', 429))).toEqual({
      status: 503,
      body: tdxWarningMessages['tdx-rate-limit'],
      shouldLog: true,
    })
  })

  it('hides unknown internal failures behind the generic public message', () => {
    expect(presentShortcutError(new Error('secret internal detail'))).toEqual({
      status: 503,
      body: '暫時無法取得公車資料',
      shouldLog: true,
    })
  })
})
