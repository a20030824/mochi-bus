import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { parseJsonWithDeadline } from './tdx-source.mjs'

class FakeWorker extends EventEmitter {
  constructor(schedule) {
    super()
    this.terminated = false
    schedule(this)
  }
  terminate() {
    this.terminated = true
    return Promise.resolve(0)
  }
}

describe('bounded worker JSON parse', () => {
  it('terminates a parse that exceeds the remaining monotonic deadline', async () => {
    vi.useFakeTimers()
    let worker
    const promise = parseJsonWithDeadline('[1]', {
      timeoutMs: 10,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        setTimeout(() => instance.emit('message', { ok: true, value: [1] }), 100)
      })),
    })
    const rejection = expect(promise).rejects.toMatchObject({ details: { failureClass: 'timeout' } })
    await vi.advanceTimersByTimeAsync(11)
    await rejection
    expect(worker.terminated).toBe(true)
    vi.useRealTimers()
  })

  it('returns parsed JSON and cleans the worker on success', async () => {
    let worker
    await expect(parseJsonWithDeadline('{"ok":true}', {
      timeoutMs: 100,
      workerFactory: () => (worker = new FakeWorker((instance) => {
        queueMicrotask(() => instance.emit('message', { ok: true, value: { ok: true } }))
      })),
    })).resolves.toEqual({ ok: true })
    expect(worker.terminated).toBe(true)
    expect(worker.listenerCount('message')).toBe(0)
    expect(worker.listenerCount('error')).toBe(0)
  })

  it.each([
    ['malformed JSON', (instance) => instance.emit('message', { ok: false, failureClass: 'invalid_json' }), 'invalid_json'],
    ['worker throw', (instance) => instance.emit('error', new Error('fake secret token')), 'parse_worker_error'],
    ['worker message failure', (instance) => instance.emit('messageerror', new Error('fake body')), 'parse_worker_message_error'],
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
