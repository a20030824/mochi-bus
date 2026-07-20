import { describe, expect, it, vi } from 'vitest'
import { createTimetableSummaryController } from './timetable-summary-controller'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush() {
  await Promise.resolve()
  await Promise.resolve()
}

describe('createTimetableSummaryController', () => {
  it('publishes an available response for the active target', async () => {
    const target = { attached: true }
    const onAvailable = vi.fn()
    const controller = createTimetableSummaryController({
      load: vi.fn(async () => ({ available: true })),
      isTargetActive: (candidate: typeof target) => candidate.attached,
      isAvailable: (response) => response.available,
      onAvailable,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    })

    const session = { cityCode: 'Taipei', variant: '307', target }
    controller.start(session)
    await flush()

    expect(onAvailable).toHaveBeenCalledWith(session, { available: true })
  })

  it('publishes the unavailable branch without treating it as an error', async () => {
    const target = { attached: true }
    const onUnavailable = vi.fn()
    const onError = vi.fn()
    const controller = createTimetableSummaryController({
      load: vi.fn(async () => ({ available: false })),
      isTargetActive: (candidate: typeof target) => candidate.attached,
      isAvailable: (response) => response.available,
      onAvailable: vi.fn(),
      onUnavailable,
      onError,
    })

    const session = { cityCode: 'Taipei', variant: '307', target }
    controller.start(session)
    await flush()

    expect(onUnavailable).toHaveBeenCalledWith(session)
    expect(onError).not.toHaveBeenCalled()
  })

  it('aborts the previous route request and ignores its late response', async () => {
    const first = deferred<{ available: boolean; route: string }>()
    const second = deferred<{ available: boolean; route: string }>()
    const signals: AbortSignal[] = []
    const targetA = { attached: true }
    const targetB = { attached: true }
    const onAvailable = vi.fn()
    const controller = createTimetableSummaryController({
      load: vi.fn((_city: string, variant: string, signal: AbortSignal) => {
        signals.push(signal)
        return variant === '307' ? first.promise : second.promise
      }),
      isTargetActive: (target: { attached: boolean }) => target.attached,
      isAvailable: (response) => response.available,
      onAvailable,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    })

    controller.start({ cityCode: 'Taipei', variant: '307', target: targetA })
    controller.start({ cityCode: 'NewTaipei', variant: '299', target: targetB })
    expect(signals[0]?.aborted).toBe(true)

    second.resolve({ available: true, route: '299' })
    await flush()
    expect(onAvailable).toHaveBeenCalledTimes(1)
    expect(onAvailable.mock.calls[0]?.[1]).toEqual({ available: true, route: '299' })

    first.resolve({ available: true, route: '307' })
    await flush()
    expect(onAvailable).toHaveBeenCalledTimes(1)
  })

  it('stops the active request and discards settlement', async () => {
    const request = deferred<{ available: boolean }>()
    let signal: AbortSignal | undefined
    const target = { attached: true }
    const onAvailable = vi.fn()
    const onUnavailable = vi.fn()
    const onError = vi.fn()
    const controller = createTimetableSummaryController({
      load: (_city, _variant, requestSignal) => {
        signal = requestSignal
        return request.promise
      },
      isTargetActive: (candidate: typeof target) => candidate.attached,
      isAvailable: (response) => response.available,
      onAvailable,
      onUnavailable,
      onError,
    })

    controller.start({ cityCode: 'Taipei', variant: '307', target })
    controller.stop()
    expect(signal?.aborted).toBe(true)

    request.resolve({ available: true })
    await flush()
    expect(onAvailable).not.toHaveBeenCalled()
    expect(onUnavailable).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
  })

  it('ignores a response after its target leaves the active drawer', async () => {
    const request = deferred<{ available: boolean }>()
    const target = { attached: true }
    const onAvailable = vi.fn()
    const controller = createTimetableSummaryController({
      load: vi.fn(() => request.promise),
      isTargetActive: (candidate: typeof target) => candidate.attached,
      isAvailable: (response) => response.available,
      onAvailable,
      onUnavailable: vi.fn(),
      onError: vi.fn(),
    })

    controller.start({ cityCode: 'Taipei', variant: '307', target })
    target.attached = false
    request.resolve({ available: true })
    await flush()

    expect(onAvailable).not.toHaveBeenCalled()
  })

  it('reports only active request failures', async () => {
    const target = { attached: true }
    const onError = vi.fn()
    const controller = createTimetableSummaryController({
      load: vi.fn(async () => { throw new Error('offline') }),
      isTargetActive: (candidate: typeof target) => candidate.attached,
      isAvailable: () => true,
      onAvailable: vi.fn(),
      onUnavailable: vi.fn(),
      onError,
    })

    const session = { cityCode: 'Taipei', variant: '307', target }
    controller.start(session)
    await flush()
    expect(onError).toHaveBeenCalledWith(session, expect.any(Error))

    target.attached = false
    controller.start(session)
    await flush()
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
