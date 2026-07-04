import { describe, expect, it } from 'vitest'
import { selectBestEta } from './eta'

const route = { routeUid: 'CYI0714', stopUid: 'CYI304410', direction: 0 }

describe('selectBestEta', () => {
  it('selects the earliest valid estimate instead of the first matching row', () => {
    const selected = selectBestEta([
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 0, StopStatus: 0 },
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 0, EstimateTime: 900, StopStatus: 0 },
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 0, EstimateTime: 240, StopStatus: 0 },
    ], route)
    expect(selected?.EstimateTime).toBe(240)
  })

  it('ignores another direction and physical stop', () => {
    const selected = selectBestEta([
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 1, EstimateTime: 60 },
      { RouteUID: 'CYI0714', StopUID: 'OTHER', Direction: 0, EstimateTime: 30 },
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 0, EstimateTime: 600 },
    ], route)
    expect(selected?.EstimateTime).toBe(600)
  })

  it('disambiguates co-located subroutes sharing the same routeUid+stopUid+direction', () => {
    const items = [
      { RouteUID: 'CYI0714', SubRouteUID: 'CYI071401', StopUID: 'CYI304410', Direction: 0, EstimateTime: 660 },
      { RouteUID: 'CYI0714', SubRouteUID: 'CYI0714A1', StopUID: 'CYI304410', Direction: 0, EstimateTime: 900 },
    ]
    expect(selectBestEta(items, { ...route, subRouteUid: 'CYI071401' })?.EstimateTime).toBe(660)
    expect(selectBestEta(items, { ...route, subRouteUid: 'CYI0714A1' })?.EstimateTime).toBe(900)
  })

  it('falls back to matching without subRouteUid when the source data lacks it', () => {
    const selected = selectBestEta([
      { RouteUID: 'CYI0714', StopUID: 'CYI304410', Direction: 0, EstimateTime: 300 },
    ], { ...route, subRouteUid: 'CYI071401' })
    expect(selected?.EstimateTime).toBe(300)
  })
})
