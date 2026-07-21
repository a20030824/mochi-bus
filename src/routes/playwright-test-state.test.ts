import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTDXTestState } from '../lib/tdx'
import testState from './playwright-test-state'

type PlaywrightBindings = CloudflareBindings & { PLAYWRIGHT_TEST_MODE?: string }

const enabledBindings = { PLAYWRIGHT_TEST_MODE: '1' } as PlaywrightBindings
const productionBindings = {} as CloudflareBindings

function request(path: string, init: RequestInit = {}, bindings: CloudflareBindings = enabledBindings) {
  return Promise.resolve(testState.request(`https://bus.example${path}`, init, bindings))
}

beforeEach(() => resetTDXTestState())
afterEach(() => resetTDXTestState())

describe('Playwright Worker state controls', () => {
  it('does not expose test controls without the explicit local binding', async () => {
    const response = await request('/__test/tdx-state/status', {}, productionBindings)
    expect(response.status).toBe(404)
  })

  it('poisons and resets the real shared TDX rate-limit state', async () => {
    const initial = await request('/__test/tdx-state/status')
    await expect(initial.json()).resolves.toEqual({ warning: 'tdx-rate-limit' })

    const poison = await request('/__test/tdx-state/poison', { method: 'POST' })
    expect(poison.status).toBe(204)
    expect(poison.headers.get('Cache-Control')).toBe('no-store')

    const polluted = await request('/__test/tdx-state/status')
    await expect(polluted.json()).resolves.toEqual({ warning: 'tdx-quota' })

    const reset = await request('/__test/tdx-state/reset', { method: 'POST' })
    expect(reset.status).toBe(204)

    const restored = await request('/__test/tdx-state/status')
    await expect(restored.json()).resolves.toEqual({ warning: 'tdx-rate-limit' })
  })
})
