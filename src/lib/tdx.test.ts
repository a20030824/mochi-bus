import { describe, expect, it } from 'vitest'
import { formatETALabel, formatStopStatus, mergeEquivalentStopGroups, withUserTDX, type StopGroup, type TDXEnv } from './tdx'

describe('TDX presentation', () => {
  it('formats immediate arrivals', () => {
    expect(formatETALabel(1, 0)).toBe('即將進站')
  })

  it('formats ordinary ETAs', () => {
    expect(formatETALabel(7, 0)).toBe('7 分')
  })

  it('falls back to the TDX stop status', () => {
    expect(formatETALabel(null, 1)).toBe('尚未發車')
    expect(formatStopStatus(4)).toBe('今日未營運')
  })
})

describe('withUserTDX', () => {
  const env: TDXEnv = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }

  it('attaches trimmed user credentials without touching the shared ones', () => {
    const result = withUserTDX(env, ' user-id ', ' user-secret ')
    expect(result.TDX_USER_CLIENT_ID).toBe('user-id')
    expect(result.TDX_USER_CLIENT_SECRET).toBe('user-secret')
    expect(result.TDX_CLIENT_ID).toBe('shared-id')
    // 原本的 env 物件不可以被改到(它是跨請求共用的 bindings)
    expect(env).not.toHaveProperty('TDX_USER_CLIENT_ID')
  })

  it('ignores missing, blank, or oversized credentials', () => {
    expect(withUserTDX(env)).toBe(env)
    expect(withUserTDX(env, 'id-only')).toBe(env)
    expect(withUserTDX(env, '  ', 'secret')).toBe(env)
    expect(withUserTDX(env, 'x'.repeat(121), 'secret')).toBe(env)
    expect(withUserTDX(env, 'id', 'x'.repeat(241))).toBe(env)
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
