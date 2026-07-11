import { describe, expect, it } from 'vitest'
import { routePatternKey, sameRoutePattern } from './route-pattern'

describe('route pattern identity', () => {
  it('distinguishes subroutes and snapshot patterns under the same RouteUID', () => {
    const base = { routeUid: 'R1', subRouteUid: 'S1', patternId: 'P1', direction: 0 as const }
    expect(routePatternKey(base)).not.toBe(routePatternKey({ ...base, subRouteUid: 'S2' }))
    expect(routePatternKey(base)).not.toBe(routePatternKey({ ...base, patternId: 'P2' }))
  })

  it('distinguishes same-name routes when both RouteUID values are known', () => {
    expect(sameRoutePattern(
      { routeName: '203', routeUid: 'R1', direction: 0 },
      { routeName: '203', routeUid: 'R2', direction: 0 },
    )).toBe(false)
  })

  it('dual-reads legacy records missing optional pattern fields', () => {
    expect(sameRoutePattern(
      { routeName: '307', routeUid: 'R1', direction: 0 },
      { routeName: '307', routeUid: 'R1', subRouteUid: 'S1', patternId: 'P1', direction: 0 },
    )).toBe(true)
  })
})
