import { describe, expect, it } from 'vitest'
import type { DirectRoute, TransferPlan } from './map-api-client'
import source from './trip-results-view.ts?raw'
import { directRouteSummary, transferLegSummary, transferPlanSummary } from './trip-results-view'

function directRoute(overrides: Partial<DirectRoute> = {}): DirectRoute {
  return {
    routeUid: 'TPE-307',
    routeName: '307',
    variantKey: '307:0',
    direction: 0,
    label: '往撫遠街',
    subRouteName: '307',
    stopUid: 'stop-1',
    stopName: '板橋車站',
    stopSequence: 1,
    estimateSeconds: null,
    etaLabel: '未發車',
    stopStatus: 0,
    source: 'none',
    boardSequence: 1,
    alightSequence: 6,
    stopCount: 5,
    ...overrides,
  }
}

function transferPlan(overrides: Partial<TransferPlan> = {}): TransferPlan {
  return {
    transferPlaceId: 'transfer',
    transferName: '轉乘站',
    totalStops: 9,
    first: {
      routeName: '307',
      variantKey: '307:0',
      label: '往撫遠街',
      boardSequence: 1,
      alightSequence: 4,
      stopCount: 3,
    },
    second: {
      routeName: '605',
      variantKey: '605:0',
      label: '往汐止',
      boardSequence: 2,
      alightSequence: 8,
      stopCount: 6,
    },
    ...overrides,
  }
}

const now = new Date('2026-07-17T00:00:00.000Z')

describe('Trip results view presentation', () => {
  it('formats direct route wait and stop count without owning result selection', () => {
    expect(directRouteSummary(directRoute({ etaMinutes: 7, etaSource: 'realtime' }), now))
      .toBe('7 分到站 · 5 站')
    expect(directRouteSummary(directRoute({ etaMinutes: null }), now)).toBe('5 站')
  })

  it('formats each transfer leg with its own ETA semantics', () => {
    const plan = transferPlan({
      firstEtaMinutes: 8,
      firstEtaSource: 'schedule',
      firstEtaDepartureBased: true,
      secondEtaMinutes: 4,
      secondEtaSource: 'realtime',
    })

    expect(transferLegSummary(plan, 0, now)).toBe('約 8 分後發車 · 3 站 · 往撫遠街')
    expect(transferLegSummary(plan, 1, now)).toBe('4 分到站 · 6 站 · 往汐止')
  })

  it('keeps the conservative fallback when transfer timing is unavailable', () => {
    expect(transferPlanSummary(transferPlan())).toEqual({
      label: '共 9 站',
      note: '未取得足夠資料，請以現場資訊為準',
      connectionTight: false,
    })
  })

  it('stays a presentation boundary without importing app-shell concerns', () => {
    expect(source).not.toMatch(/from ['"]leaflet['"]|history-state|camera-controller|trip-controller[^']*['"]/)
    expect(source).not.toContain('window.history')
    expect(source).not.toContain('mapApi.')
  })
})
