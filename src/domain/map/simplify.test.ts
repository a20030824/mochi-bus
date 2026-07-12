import { describe, expect, it } from 'vitest'
import { simplifyLine } from './simplify'
import type { LonLat } from './network-pick'

describe('simplifyLine', () => {
  it('保留起訖點,即使容差極大', () => {
    const line: LonLat[] = [[121, 25], [121.001, 25.0005], [121.002, 25.001]]
    const result = simplifyLine(line, 10_000)
    expect(result[0]).toEqual(line[0])
    expect(result[result.length - 1]).toEqual(line[line.length - 1])
  })

  it('近乎直線的中間點在容差內會被丟掉', () => {
    // 中間點偏離起訖連線大約 5.6m,小於正式全路網使用的 8m 容差
    const line: LonLat[] = [[121, 25], [121.0005, 25.00005], [121.001, 25]]
    const result = simplifyLine(line, 8)
    expect(result).toEqual([line[0], line[2]])
  })

  it('偏離明顯超過容差的中間點會被保留', () => {
    // 中間點往北偏移約 0.001 度緯度(約 111m),遠大於 8m 容差
    const line: LonLat[] = [[121, 25], [121.0005, 25.001], [121.001, 25]]
    const result = simplifyLine(line, 8)
    expect(result).toEqual(line)
  })

  it('遞迴會保留每一段裡真正的轉折點(之字形不會被拉直)', () => {
    const line: LonLat[] = [
      [121, 25],
      [121.0002, 25.002],
      [121.0004, 25],
      [121.0006, 25.002],
      [121.0008, 25],
    ]
    const result = simplifyLine(line, 5)
    expect(result).toEqual(line)
  })

  it('兩點或以下的線原樣回傳', () => {
    const line: LonLat[] = [[121, 25], [121.001, 25.001]]
    expect(simplifyLine(line, 1000)).toEqual(line)
  })

  it('容差為 0 時原樣回傳', () => {
    const line: LonLat[] = [[121, 25], [121.0005, 25.0005], [121.001, 25.001]]
    expect(simplifyLine(line, 0)).toEqual(line)
  })
})
