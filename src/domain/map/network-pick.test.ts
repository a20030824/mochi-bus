import { describe, expect, it } from 'vitest'
import { buildNetworkIndex, pickNetwork, type LonLat } from './network-pick'

// 台灣尺度的測資:經度要乘 cos(緯度) 校正,測試同時釘住這件事。
const line = (...points: LonLat[]): LonLat[] => points

describe('pickNetwork', () => {
  it('空索引查不到東西', () => {
    const index = buildNetworkIndex([], [])
    expect(pickNetwork(index, [121, 24], 0.01, 0.01)).toBeUndefined()
  })

  it('容差內命中路線,容差外不命中', () => {
    const index = buildNetworkIndex([line([121, 24], [121, 24.1])], [])
    expect(pickNetwork(index, [121.001, 24.05], 0.002, 0.001)).toEqual({ kind: 'route', routeIndex: 0 })
    expect(pickNetwork(index, [121.01, 24.05], 0.002, 0.001)).toBeUndefined()
  })

  it('多條路線回傳最近的一條', () => {
    const index = buildNetworkIndex([
      line([121, 24], [121, 24.1]),
      line([121.004, 24], [121.004, 24.1]),
    ], [])
    expect(pickNetwork(index, [121.003, 24.05], 0.005, 0.001)).toEqual({ kind: 'route', routeIndex: 1 })
  })

  it('站點容差內時優先於更近的路線', () => {
    const index = buildNetworkIndex(
      [line([121, 24], [121, 24.1])],
      [[121.002, 24.05]],
    )
    // 游標貼著線,但站點也在容差內:站點贏
    expect(pickNetwork(index, [121.0005, 24.05], 0.003, 0.003)).toEqual({ kind: 'place', placeIndex: 0 })
    // 站點容差縮小到吃不到,才輪到路線
    expect(pickNetwork(index, [121.0005, 24.05], 0.003, 0.0005)).toEqual({ kind: 'route', routeIndex: 0 })
  })

  it('多個站點回傳最近的一個', () => {
    const index = buildNetworkIndex([], [[121, 24.05], [121.001, 24.05]])
    expect(pickNetwork(index, [121.0008, 24.05], 0.001, 0.003)).toEqual({ kind: 'place', placeIndex: 1 })
  })

  it('長線段斜跨多格,從中段附近也查得到', () => {
    // 單一線段跨約 0.1 度(遠大於 0.004 的格子),命中點離兩端都很遠
    const index = buildNetworkIndex([line([121, 24], [121.1, 24.1])], [])
    expect(pickNetwork(index, [121.05, 24.0505], 0.002, 0.001)).toEqual({ kind: 'route', routeIndex: 0 })
  })

  it('經度距離乘上 cos(緯度) 校正,容差在兩軸等值', () => {
    const index = buildNetworkIndex([line([121, 24], [121, 24.1])], [])
    // 經度偏 0.01 度,校正後距離 ≈ 0.01 × cos(24°) ≈ 0.00913
    expect(pickNetwork(index, [121.01, 24.05], 0.0095, 0.001)).toEqual({ kind: 'route', routeIndex: 0 })
    expect(pickNetwork(index, [121.01, 24.05], 0.009, 0.001)).toBeUndefined()
  })
})
