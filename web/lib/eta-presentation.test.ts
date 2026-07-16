import { describe, expect, it } from 'vitest'
import { formatJourneyWait, splitEtaLabel } from './eta-presentation'

describe('ETA presentation', () => {
  it('separates number, prefix, and unit without changing visible wording', () => {
    expect(splitEtaLabel('約 7 分')).toEqual({ prefix: '約', value: '7', suffix: '分' })
    expect(splitEtaLabel('9 分後發車')).toEqual({ prefix: '', value: '9', suffix: '分後發車' })
    expect(splitEtaLabel('明日 05:40 發車')).toEqual({ prefix: '明日', value: '05:40', suffix: '發車' })
    expect(splitEtaLabel('到站')).toEqual({ prefix: '', value: '到站', suffix: '' })
  })

  it('uses absolute time beyond one hour and marks schedule estimates', () => {
    const now = new Date('2026-07-17T00:00:00.000Z')
    expect(formatJourneyWait(7, 'realtime', now)).toBe('7 分到站')
    expect(formatJourneyWait(7, 'schedule', now)).toBe('約 7 分')
    expect(formatJourneyWait(61, 'realtime', now)).toBe('09:01 到站')
    expect(formatJourneyWait(120, 'realtime', new Date('2026-07-17T15:30:00.000Z'))).toBe('明日 01:30 到站')
  })
})
