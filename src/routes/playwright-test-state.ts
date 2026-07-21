import { Hono } from 'hono'
import {
  TDXServiceError,
  resetTDXTestState,
} from '../lib/tdx'
import {
  observeTDXResponseFailure,
  tdxWarningFromError,
} from '../lib/tdx/error-classification'

type Env = { Bindings: CloudflareBindings }
type PlaywrightBindings = CloudflareBindings & { PLAYWRIGHT_TEST_MODE?: string }

const testState = new Hono<Env>()

function enabled(bindings: CloudflareBindings): boolean {
  return (bindings as PlaywrightBindings).PLAYWRIGHT_TEST_MODE === '1'
}

function noStore() {
  return { 'Cache-Control': 'no-store' } as const
}

testState.use('/__test/tdx-state/*', async (c, next) => {
  if (!enabled(c.env)) return c.notFound()
  await next()
})

testState.post('/__test/tdx-state/reset', (c) => {
  resetTDXTestState()
  return c.body(null, 204, noStore())
})

testState.post('/__test/tdx-state/poison', (c) => {
  observeTDXResponseFailure(429, 'tdx-rate-limit', true, Date.now() - 11 * 60 * 1000)
  return c.body(null, 204, noStore())
})

testState.get('/__test/tdx-state/status', (c) => {
  const error = new TDXServiceError('Playwright state probe', 429)
  return c.json({ warning: tdxWarningFromError(error) }, 200, noStore())
})

export default testState
