import { describe, expect, it } from 'vitest'
import { tdxWarningMessages } from '../lib/tdx'
import { resolveTDXNotice } from './bus'

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
