import { describe, expect, it } from 'vitest'
import { splitRouteDisplayName } from './route-display'

describe('route display names', () => {
  it('splits only a complete trailing parenthetical note', () => {
    expect(splitRouteDisplayName('中山幹線(綠線)')).toEqual({ name: '中山幹線', note: '(綠線)' })
    expect(splitRouteDisplayName('市民小巴（預約）')).toEqual({ name: '市民小巴', note: '（預約）' })
  })

  it('preserves unmatched or embedded parentheses', () => {
    expect(splitRouteDisplayName('(測試)')).toEqual({ name: '(測試)' })
    expect(splitRouteDisplayName('A(區間)B')).toEqual({ name: 'A(區間)B' })
    expect(splitRouteDisplayName('A(區間')).toEqual({ name: 'A(區間' })
  })
})
