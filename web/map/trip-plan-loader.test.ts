import { describe, expect, it, vi } from 'vitest'
import type { DirectRoute, JourneyEtaEstimate, TransferPlan } from './map-api-client'
import { createTripPlanLoader } from './trip-plan-loader'

const credentialError = new Error('credential rejected')

function directRoute(routeName: string, stopCount: number): DirectRoute {
  return {
    routeUid: `TPE${routeName}`,
    routeName,
    variantKey: `${routeName}:0`,
    direction: 0,
    label: '往終點',
    subRouteName: routeName,
    stopUid: 'stop',
    stopName: '站牌',
    stopSequence: 1,
    estimateSeconds: null,
    etaLabel: '未發車',
    stopStatus: 0,
    source: 'none',
    boardSequence: 1,
    alightSequence: stopCount + 1,
    stopCount,
  }
}

function transferPlan(first: string, second: string, totalStops = 8): TransferPlan {
  return {
    transferPlaceId: 'transfer',
    transferName: '轉乘站',
    transferWalkMeters: 120,
    totalStops,
    first: {
      routeName: first,
      variantKey: `${first}:0`,
      label: '第一段',
      boardSequence: 1,
      alightSequence: 4,
      stopCount: 3,
    },
    second: {
      routeName: second,
      variantKey: `${second}:0`,
      label: '第二段',
      boardSequence: 2,
      alightSequence: 7,
      stopCount: 5,
    },
  }
}

function eta(key: string, minutes: number | null, source: JourneyEtaEstimate['source'] = 'realtime'): JourneyEtaEstimate {
  return { key, minutes, source }
}

function createHarness(overrides: Partial<Parameters<typeof createTripPlanLoader>[0]> = {}) {
  const options = {
    loadDirect: vi.fn(async () => [] as DirectRoute[]),
    loadTransfer: vi.fn(async () => [] as TransferPlan[]),
    loadJourneyEta: vi.fn(async () => ({ estimates: [] as JourneyEtaEstimate[] })),
    isCredentialRejectedError: vi.fn((error: unknown) => error === credentialError),
    ...overrides,
  }
  return {
    options,
    loader: createTripPlanLoader(options),
  }
}

const request = {
  cityCode: 'Taipei',
  fromPlaceId: 'from',
  toPlaceId: 'to',
}

describe('trip plan loader', () => {
  it('returns ranked direct routes without issuing the transfer fallback', async () => {
    const slow = directRoute('slow', 4)
    const fast = directRoute('fast', 12)
    const harness = createHarness({
      loadDirect: vi.fn(async () => [slow, fast]),
      loadJourneyEta: vi.fn(async () => ({
        warning: 'tdx-rate-limit' as const,
        estimates: [
          eta('direct:0', null, 'none'),
          eta('direct:1', 3),
        ],
      })),
    })
    const phases: string[] = []

    const result = await harness.loader.load({ ...request, onPhase: (phase) => phases.push(phase) })

    expect(result).toMatchObject({
      kind: 'direct',
      warning: 'tdx-rate-limit',
      routes: [
        { routeName: 'fast', etaMinutes: 3, etaSource: 'realtime' },
        { routeName: 'slow', etaMinutes: null, etaSource: 'none' },
      ],
    })
    expect(phases).toEqual(['direct'])
    expect(harness.options.loadTransfer).not.toHaveBeenCalled()
  })

  it('keeps departure-based schedule times behind reliable realtime arrivals', async () => {
    const scheduleDeparture = directRoute('schedule', 2)
    const realtimeArrival = directRoute('realtime', 8)
    const harness = createHarness({
      loadDirect: vi.fn(async () => [scheduleDeparture, realtimeArrival]),
      loadJourneyEta: vi.fn(async () => ({
        estimates: [
          { ...eta('direct:0', 1, 'schedule'), departureBased: true },
          eta('direct:1', 6, 'realtime'),
        ],
      })),
    })

    const result = await harness.loader.load(request)

    expect(result).toMatchObject({
      kind: 'direct',
      routes: [
        { routeName: 'realtime', etaMinutes: 6, etaSource: 'realtime' },
        { routeName: 'schedule', etaMinutes: 1, etaSource: 'schedule', etaDepartureBased: true },
      ],
    })
  })

  it('falls back to transfer plans and enriches both legs with ETA and connection estimates', async () => {
    const plan = transferPlan('307', '605')
    const harness = createHarness({
      loadTransfer: vi.fn(async () => [plan]),
      loadJourneyEta: vi.fn(async () => ({
        estimates: [
          eta('transfer:0:first', 3),
          eta('transfer:0:second', 14),
        ],
      })),
    })
    const phases: string[] = []

    const result = await harness.loader.load({ ...request, onPhase: (phase) => phases.push(phase) })

    expect(result).toMatchObject({
      kind: 'transfer',
      plans: [{
        firstEtaMinutes: 3,
        secondEtaMinutes: 14,
        firstEtaSource: 'realtime',
        secondEtaSource: 'realtime',
        transferEstimate: expect.any(Object),
      }],
    })
    expect(phases).toEqual(['direct', 'transfer'])
  })

  it('returns an empty result without requesting ETA when no one-transfer plan exists', async () => {
    const harness = createHarness()

    await expect(harness.loader.load(request)).resolves.toEqual({ kind: 'empty' })
    expect(harness.options.loadJourneyEta).not.toHaveBeenCalled()
  })

  it('degrades non-credential ETA failures while preserving the route result', async () => {
    const route = directRoute('307', 5)
    const harness = createHarness({
      loadDirect: vi.fn(async () => [route]),
      loadJourneyEta: vi.fn(async () => { throw new Error('TDX unavailable') }),
    })

    const result = await harness.loader.load(request)

    expect(result).toMatchObject({
      kind: 'direct',
      warning: 'tdx-unavailable',
      routes: [{ routeName: '307', etaMinutes: null, etaSource: 'none' }],
    })
  })

  it('propagates credential rejection instead of disguising it as missing ETA', async () => {
    const harness = createHarness({
      loadDirect: vi.fn(async () => [directRoute('307', 5)]),
      loadJourneyEta: vi.fn(async () => { throw credentialError }),
    })

    await expect(harness.loader.load(request)).rejects.toBe(credentialError)
  })

  it('stops after an aborted direct request result and does not start ETA work', async () => {
    const controller = new AbortController()
    const harness = createHarness({
      loadDirect: vi.fn(async () => {
        controller.abort()
        return [directRoute('307', 5)]
      }),
    })

    await expect(harness.loader.load({ ...request, signal: controller.signal })).resolves.toBeUndefined()
    expect(harness.options.loadJourneyEta).not.toHaveBeenCalled()
  })

  it('stops after an aborted transfer result and does not start leg ETA work', async () => {
    const controller = new AbortController()
    const harness = createHarness({
      loadTransfer: vi.fn(async () => {
        controller.abort()
        return [transferPlan('307', '605')]
      }),
    })

    await expect(harness.loader.load({ ...request, signal: controller.signal })).resolves.toBeUndefined()
    expect(harness.options.loadJourneyEta).not.toHaveBeenCalled()
  })
})
