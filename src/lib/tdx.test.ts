import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedBusQuery } from '../domain/bus-query'
import { formatETALabel, formatStopStatus, getCommuteETA, mergeEquivalentStopGroups, resetTDXRateLimitTracking, verifyTDXCredentials, withUserTDX, type StopGroup, type TDXEnv } from './tdx'

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

describe('TDX upstream failures', () => {
  const env: TDXEnv = { TDX_CLIENT_ID: 'shared-id', TDX_CLIENT_SECRET: 'shared-secret' }
  const query = {
    city: 'Taipei',
    routeName: '307',
    routeUid: 'TPE19108',
    stopName: '捷運西門站',
    stopUid: 'TPE213044',
    direction: 0,
  } satisfies ResolvedBusQuery

  const stubRateLimitedTDX = () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 429 })))
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    resetTDXRateLimitTracking()
  })

  it('marks ETA results when the shared TDX pool is rate limited', async () => {
    stubRateLimitedTDX()

    const result = await getCommuteETA(env, query)

    expect(result.warning).toBe('tdx-rate-limit')
    expect(result.label).toBe('暫無預估時間')
  })

  it('escalates to a quota warning when 429 persists past the threshold', async () => {
    stubRateLimitedTDX()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T08:00:00+08:00'))

    const first = await getCommuteETA(env, query)
    expect(first.warning).toBe('tdx-rate-limit')

    // 頻率超限幾秒就恢復;429 一路持續超過門檻,就該改判成「共用額度可能已用完」。
    vi.setSystemTime(new Date('2026-07-08T08:15:00+08:00'))
    const second = await getCommuteETA(env, query)
    expect(second.warning).toBe('tdx-quota')
  })

  it('does not let a personal credential test on the setup page contaminate the shared quota tracker', async () => {
    stubRateLimitedTDX()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-08T08:00:00+08:00'))

    // setup 頁「儲存並測試」打的是使用者自備憑證,持續撞 429 是他個人帳號的事。
    await expect(verifyTDXCredentials('personal-id', 'personal-secret')).rejects.toThrow()
    vi.setSystemTime(new Date('2026-07-08T08:15:00+08:00'))
    await expect(verifyTDXCredentials('personal-id', 'personal-secret')).rejects.toThrow()

    // 共用憑證本身一次都還沒失敗過,不該被這些測試請求的 429 波及而升級成「額度已用完」。
    const result = await getCommuteETA(env, query)
    expect(result.warning).toBe('tdx-rate-limit')
  })

  it('recognizes quota responses even when TDX does not use HTTP 429', async () => {
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('monthly quota exceeded', { status: 403 })))

    const result = await getCommuteETA(env, query)

    expect(result.warning).toBe('tdx-quota')
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
