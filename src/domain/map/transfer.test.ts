import { describe, expect, it } from 'vitest'
import { pairTransferLegs, type TransferLegCandidate } from './transfer'

function leg(overrides: Partial<TransferLegCandidate>): TransferLegCandidate {
  return {
    patternId: 'P1',
    routeUid: 'R1',
    routeName: '1',
    label: '起點 → 終點',
    placeId: 'place-a',
    placeName: '轉乘站',
    latitude: 22.99,
    longitude: 120.21,
    boardSequence: 1,
    alightSequence: 5,
    stopCount: 4,
    ...overrides,
  }
}

describe('pairTransferLegs', () => {
  it('pairs legs meeting at the same place with zero walk', () => {
    const plans = pairTransferLegs(
      [leg({ routeUid: 'R1', routeName: '1' })],
      [leg({ routeUid: 'R2', routeName: '2', patternId: 'P2' })],
    )
    expect(plans).toHaveLength(1)
    expect(plans[0].transferWalkMeters).toBe(0)
    expect(plans[0].transferName).toBe('轉乘站')
    expect(plans[0].totalStops).toBe(8)
  })

  it('pairs walkable places across grid cell boundaries', () => {
    // 緯度 +0.003° ≈ 334m,在 350m 內但幾乎必然跨網格
    const plans = pairTransferLegs(
      [leg({ routeUid: 'R1' })],
      [leg({ routeUid: 'R2', patternId: 'P2', placeId: 'place-b', placeName: '對街站', latitude: 22.993 })],
    )
    expect(plans).toHaveLength(1)
    expect(plans[0].transferWalkMeters).toBeGreaterThan(300)
    expect(plans[0].transferName).toBe('轉乘站 ↔ 對街站')
  })

  it('rejects transfers beyond walking distance', () => {
    const plans = pairTransferLegs(
      [leg({ routeUid: 'R1' })],
      [leg({ routeUid: 'R2', patternId: 'P2', placeId: 'place-far', latitude: 22.994 })],
    )
    expect(plans).toHaveLength(0)
  })

  it('rejects pairs on the same route', () => {
    const plans = pairTransferLegs(
      [leg({ routeUid: 'R1', patternId: 'P1' })],
      [leg({ routeUid: 'R1', patternId: 'P1B' })],
    )
    expect(plans).toHaveLength(0)
  })

  it('keeps the shortest option per pattern and place before pairing', () => {
    const plans = pairTransferLegs(
      [
        leg({ routeUid: 'R1', boardSequence: 1, alightSequence: 9, stopCount: 8 }),
        leg({ routeUid: 'R1', boardSequence: 1, alightSequence: 4, stopCount: 3 }),
      ],
      [leg({ routeUid: 'R2', patternId: 'P2', stopCount: 2 })],
    )
    expect(plans).toHaveLength(1)
    expect(plans[0].first.stopCount).toBe(3)
    expect(plans[0].totalStops).toBe(5)
  })

  it('ranks by total stops plus walk penalty and limits results', () => {
    const backward = [...Array(8)].map((_, index) => leg({
      routeUid: `R${index + 2}`,
      routeName: `${index + 2}`,
      patternId: `P${index + 2}`,
      stopCount: index + 1,
    }))
    const plans = pairTransferLegs([leg({ routeUid: 'R1', stopCount: 1 })], backward)
    expect(plans).toHaveLength(5)
    expect(plans.map((plan) => plan.totalStops)).toEqual([2, 3, 4, 5, 6])
  })
})
