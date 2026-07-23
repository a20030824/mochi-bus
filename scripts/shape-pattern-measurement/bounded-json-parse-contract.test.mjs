import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseJsonWithDeadline } from './tdx-source.mjs'

class FakeWorker extends EventEmitter {
  constructor(schedule) {
    super()
    this.terminated = false
    this.cancel = null
    schedule(this)
  }
  terminate() {
    this.terminated = true
    this.cancel?.()
    return Promise.resolve(0)
  }
}

afterEach(() => vi.useRealTimers())

describe('bounded worker JSON parse', () => {
  it('terminates a parse that exceeds the remaining monotonic deadline', async () => {
    vi.useFakeTimers()
    let worker
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        const timer = setTimeout(() => instance.emit('message', { ok: true, value: [1] }), 100)
        instance.cancel = () => clearTimeout(timer)
      })),
    })
    const rejection = expect(promise).rejects.toMatchObject({ details: { failureClass: 'timeout' } })
    await vi.advanceTimersByTimeAsync(11)
    await rejection
    expect(worker.terminated).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns parsed JSON and removes every worker listener on success', async () => {
    let worker
    await expect(parseJsonWithDeadline('{"ok":true}', {
      timeoutMs: 100,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        queueMicrotask(() => instance.emit('message', { ok: true, value: { ok: true } }))
      })),
    })).resolves.toEqual({ ok: true })
    expect(worker.terminated).toBe(true)
    for (const event of ['message', 'error', 'messageerror', 'exit']) {
      expect(worker.listenerCount(event)).toBe(0)
    }
  })

  it.each([
    ['malformed JSON', (instance) => instance.emit('message', { ok: false, failureClass: 'invalid_json' }), 'invalid_json'],
    ['worker throw', (instance) => instance.emit('error', new Error('fake secret token')), 'parse_worker_error'],
    ['worker message failure', (instance) => instance.emit('messageerror', new Error('fake body')), 'parse_worker_message_error'],
    ['worker exit without result', (instance) => instance.emit('exit', 0), 'parse_worker_error'],
  ])('returns a bounded error for %s', async (_name, emit, failureClass) => {
    const error = await parseJsonWithDeadline('secret body', {
      timeoutMs: 100,
      workerFactory: () => new FakeWorker((instance) => queueMicrotask(() => emit(instance))),
    }).catch((caught) => caught)
    expect(error.details.failureClass).toBe(failureClass)
    expect(JSON.stringify(error)).not.toContain('secret body')
    expect(String(error.stack)).not.toContain('fake secret token')
  })

  it('does not create a worker when the deadline is already exhausted', async () => {
    const workerFactory = vi.fn()
    await expect(parseJsonWithDeadline('[]', { timeoutMs: 0, workerFactory })).rejects.toMatchObject({ details: { failureClass: 'timeout' } })
    expect(workerFactory).not.toHaveBeenCalled()
  })
})
