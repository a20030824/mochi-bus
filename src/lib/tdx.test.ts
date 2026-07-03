import { describe, expect, it } from 'vitest'
import { formatETALabel, formatStopStatus, mergeEquivalentStopGroups, type StopGroup } from './tdx'

describe('TDX presentation', () => {
  it('formats immediate arrivals', () => {
    expect(formatETALabel(1, 0)).toBe('即將進站')
  })

  it('formats ordinary ETAs', () => {
    expect(formatETALabel(7, 0)).toBe('7 分鐘')
  })

  it('falls back to the TDX stop status', () => {
    expect(formatETALabel(null, 1)).toBe('尚未發車')
    expect(formatStopStatus(4)).toBe('今日未營運')
  })
})

describe('route variants', () => {
  const group = (name: string, stops: string[]): StopGroup => ({
    direction: 0,
    label: `${stops[0]} → ${stops.at(-1)}`,
    subRouteName: name,
    stops: stops.map((stopName, index) => ({
      subRouteName: name,
      stopUid: `${name}-${index}`,
      stopName,
      direction: 0,
      sequence: index + 1,
    })),
  })

  it('merges variants with the same complete stop sequence', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', ['起點', '中間', '終點']),
      group('B支線', ['起點', '中間', '終點']),
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0].subRouteName).toBe('A支線／B支線')
  })

  it('keeps variants that take different paths', () => {
    const merged = mergeEquivalentStopGroups([
      group('A支線', ['起點', '中山路', '終點']),
      group('B支線', ['起點', '西藏路', '終點']),
    ])

    expect(merged).toHaveLength(2)
  })
})
