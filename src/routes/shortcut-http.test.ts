import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import app from '../index'
import { resetTDXTestState } from '../lib/tdx'

const aliases = ['/shortcut', '/bus/text', '/text'] as const
const bearerHeaders = { Authorization: 'Bearer shortcut-contract-token' }

function shortcutUrl(path: string, routeName = 'shortcut-success', city = 'Taipei') {
  const url = new URL(path, 'https://bus.moc96336.com')
  url.searchParams.set('city', city)
  url.searchParams.set('route', routeName)
  url.searchParams.set('routeUid', `TPE-${routeName}`)
  url.searchParams.set('subRouteUid', `TPE-${routeName}-0`)
  url.searchParams.set('direction', '0')
  url.searchParams.set('stop', '捷運西門站')
  url.searchParams.set('stopUid', 'TPE-SHORTCUT-STOP')
  return url
}

function shortcutLogCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return (spy.mock.calls as unknown[][]).filter((call) => call[0] === 'shortcut_eta_failed')
}

async function responseText(response: Response, status: number) {
  expect(response.status).toBe(status)
  expect(response.headers.get('content-type')).toContain('text/plain')
  return response.text()
}

describe('shortcut text alias HTTP contract', () => {
  let consoleError: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    resetTDXTestState()
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async () => undefined),
        put: vi.fn(async () => undefined),
      },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    resetTDXTestState()
  })

  it('returns the same successful text contract from every alias', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/StopOfRoute/')) {
        return Response.json([{
          RouteUID: 'TPE-shortcut-success',
          RouteName: { Zh_tw: 'shortcut-success' },
          SubRouteUID: 'TPE-shortcut-success-0',
          SubRouteName: { Zh_tw: 'shortcut-success' },
          Direction: 0,
          Stops: [{
            StopUID: 'TPE-SHORTCUT-STOP',
            StopName: { Zh_tw: '捷運西門站' },
            StopSequence: 1,
          }],
        }])
      }
      if (url.includes('/EstimatedTimeOfArrival/')) {
        return Response.json([{
          RouteUID: 'TPE-shortcut-success',
          RouteName: { Zh_tw: 'shortcut-success' },
          SubRouteUID: 'TPE-shortcut-success-0',
          StopUID: 'TPE-SHORTCUT-STOP',
          StopName: { Zh_tw: '捷運西門站' },
          Direction: 0,
          EstimateTime: 300,
          StopStatus: 0,
          DataTime: new Date().toISOString(),
        }])
      }
      throw new Error(`unexpected upstream request: ${url}`)
    }))

    const bodies: string[] = []
    for (const path of aliases) {
      const response = await app.request(shortcutUrl(path), { headers: bearerHeaders })
      expect(response.headers.get('cache-control')).toBe('no-store')
      bodies.push(await responseText(response, 200))
    }

    expect(new Set(bodies).size).toBe(1)
    expect(bodies[0]).toMatch(/^shortcut-success｜捷運西門站\n/)
    expect(shortcutLogCalls(consoleError)).toHaveLength(0)
  })

  it('returns the same 400 public query error from every alias', async () => {
    const upstreamFetch = vi.fn()
    vi.stubGlobal('fetch', upstreamFetch)

    const bodies: string[] = []
    for (const path of aliases) {
      const response = await app.request(shortcutUrl(path, 'shortcut-invalid', 'Moon'))
      bodies.push(await responseText(response, 400))
    }

    expect(new Set(bodies)).toEqual(new Set(['不支援的縣市：Moon']))
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(shortcutLogCalls(consoleError)).toHaveLength(3)
  })

  it('returns the same 503 resolution error from every alias', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json([])))

    const bodies: string[] = []
    for (const path of aliases) {
      const response = await app.request(shortcutUrl(path, 'shortcut-missing'), { headers: bearerHeaders })
      bodies.push(await responseText(response, 503))
    }

    expect(new Set(bodies)).toEqual(new Set(['找不到 shortcut-missing 的 捷運西門站']))
    expect(shortcutLogCalls(consoleError)).toHaveLength(3)
  })
})
