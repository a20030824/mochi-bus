import { describe, expect, it } from 'vitest'
import { parseRouteEtaResponse } from './contract'

const valid = {
  schemaVersion: 1,
  eta: { kind: 'realtime' },
  stops: [
    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, etaLabel: '12 分', etaTone: 'live' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, etaLabel: '即將進站', etaTone: 'urgent' },
  ],
}

const tooManyStops = Array.from({ length: 1_001 }, (_, index) => ({
  ...valid.stops[0],
  stopUid: `TPE${index}`,
  sequence: index,
}))

describe('parseRouteEtaResponse', () => {
  it('accepts the versioned ordered ETA contract', () => {
    expect(parseRouteEtaResponse(valid)).toEqual(valid)
  })

  it('accepts a bounded degraded warning', () => {
    expect(parseRouteEtaResponse({
      ...valid,
      eta: { kind: 'unavailable', warning: 'tdx-rate-limit' },
      stops: valid.stops.map((stop) => ({ ...stop, etaLabel: null, etaTone: 'muted' })),
    }).eta).toEqual({ kind: 'unavailable', warning: 'tdx-rate-limit' })
  })

  it.each([
    null,
    { ...valid, schemaVersion: 2 },
    { ...valid, eta: { kind: 'unavailable', warning: 'secret-upstream-error' } },
    { ...valid, stops: [] },
    { ...valid, stops: [{ ...valid.stops[0], etaTone: 'unknown' }] },
    { ...valid, stops: [{ ...valid.stops[0], etaLabel: 12 }] },
    { ...valid, stops: [{ ...valid.stops[0], etaLabel: 'x'.repeat(65) }] },
    { ...valid, stops: [{ ...valid.stops[0], sequence: 1.5 }] },
    { ...valid, stops: [valid.stops[1], valid.stops[0]] },
    { ...valid, stops: tooManyStops },
  ])('rejects malformed or unbounded data %#', (value) => {
    expect(() => parseRouteEtaResponse(value)).toThrow()
  })
})
