import { describe, expect, it } from 'vitest'
import { etaPresentation, formatJourneyWait, splitEtaLabel } from './eta-presentation'

describe('ETA presentation', () => {
  it('separates the primary value from supporting ETA words', () => {
    expect(splitEtaLabel('約 7 分')).toEqual({ prefix: '約', value: '7', suffix: '分' })
    expect(splitEtaLabel('5–10 分一班')).toEqual({ prefix: '', value: '5–10', suffix: '分一班' })
    expect(splitEtaLabel('9 分後發車')).toEqual({ prefix: '', value: '9', suffix: '分後發車' })
    expect(splitEtaLabel('明日 05:40 發車')).toEqual({ prefix: '明日', value: '05:40', suffix: '發車' })
    expect(splitEtaLabel('到站')).toEqual({ prefix: '', value: '到站', suffix: '' })
  })

  it('derives the same trust and urgency tone for every renderer', () => {
    expect(etaPresentation('3 分', { source: 'realtime', estimateSeconds: 180 })).toMatchObject({ tone: 'urgent', stale: false })
    expect(etaPresentation('4 分', { source: 'realtime', estimateSeconds: 181 })).toMatchObject({ tone: 'default', stale: false })
    expect(etaPresentation('約 12 分', { source: 'schedule', estimateSeconds: 720 })).toMatchObject({ tone: 'estimated', stale: false })
    expect(etaPresentation('2 分', { source: 'stale-realtime', estimateSeconds: 120 })).toMatchObject({ tone: 'urgent', stale: true })
    expect(etaPresentation('7 分', { source: 'realtime', stale: true })).toMatchObject({ tone: 'default', stale: true })
  })

  it('uses absolute time beyond one hour and marks schedule estimates', () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    expect(formatJourneyWait(7, 'realtime', now)).toBe('7 分到站')
    expect(formatJourneyWait(7, 'schedule', now)).toBe('約 7 分')
    expect(formatJourneyWait(61, 'realtime', now)).toBe('09:01 到站')
    expect(formatJourneyWait(120, 'realtime', new Date('2026-07-17T15:30:00.000Z'))).toBe('明日 01:30 到站')
  })

  it('labels origin departures, frequency ranges, and next-day service without calling them arrivals', () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    expect(formatJourneyWait(75, 'schedule', now, { departureBased: true })).toBe('09:15 發車')
    expect(formatJourneyWait(15, 'schedule', now, {
      departureBased: true,
      headwayMinutes: [8, 15],
    })).toBe('8–15 分一班')
    expect(formatJourneyWait(40, 'schedule', new Date('2026-07-17T15:30:00.000Z'), {
      departureBased: true,
      nextDay: true,
    })).toBe('明日 00:10 發車')
  })
})
