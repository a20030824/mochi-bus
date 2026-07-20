import { describe, expect, it } from 'vitest'
import { tdxWarningMessages } from '../lib/tdx'
import { buildSnapshotRouteDetail, resolveTDXNotice } from './bus'

describe('resolveTDXNotice', () => {
  it('returns the matching warning message for a known TDXWarning key', () => {
    expect(resolveTDXNotice('tdx-quota')).toBe(tdxWarningMessages['tdx-quota'])
  })

  it('returns undefined for an unknown value', () => {
    expect(resolveTDXNotice('not-a-real-warning')).toBeUndefined()
  })

  it('returns undefined for undefined input', () => {
    expect(resolveTDXNotice(undefined)).toBeUndefined()
  })

  // 迴歸測試:舊寫法用 `value in tdxWarningMessages`,會沿原型鏈找到
  // Object.prototype 上的成員(constructor/toString/hasOwnProperty…),
  // 誤把它們當成合法 key 取出——拿到的不是字串而是函式,後面
  // escapeHTML() 對函式呼叫 .replaceAll 會直接丟 TypeError。
  it('does not resolve prototype-chain properties as valid notice keys', () => {
    for (const key of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(resolveTDXNotice(key)).toBeUndefined()
    }
  })
})


describe('buildSnapshotRouteDetail', () => {
  it('uses the same ETA-free shell labels and ordering as the normal Route SSR path', () => {
    const variant = {
      routeName: '307',
      direction: 0,
      label: '板橋 → 撫遠街',
      stops: {
        features: [
          { properties: { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2 } },
          { properties: { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1 } },
          { properties: { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3 } },
        ],
      },
    } as unknown as Parameters<typeof buildSnapshotRouteDetail>[0]

    const detail = buildSnapshotRouteDetail(variant, 'TPE2')

    expect(detail.stops.map((stop) => stop.stopUid)).toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '更新中',
      etaTone: 'muted',
    })
    expect(detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
    expect(detail.stops.some((stop) => stop.etaLabel === null || stop.etaLabel === '僅站序')).toBe(false)
  })
})
