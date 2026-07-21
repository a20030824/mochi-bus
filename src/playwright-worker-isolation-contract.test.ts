/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import ciSource from '../.github/workflows/ci.yml?raw'
import playwrightSource from '../playwright.config.ts?raw'
import uiFixturesSource from '../test/e2e/fixtures.ts?raw'
import statefulFixturesSource from '../test/e2e/stateful-fixtures.ts?raw'
import testRouteSource from './routes/playwright-test-state.ts?raw'

describe('Playwright Worker state isolation boundary', () => {
  it('keeps stateful specs out of the parallel UI projects', () => {
    expect(playwrightSource).toContain("const workerStatefulSpec = /worker-stateful\\.spec\\.ts/")
    expect(playwrightSource).toContain('testIgnore: [/mobile-touch\\.spec\\.ts/, /(?:map|ui)-visual\\.spec\\.ts/, workerStatefulSpec]')
    expect(playwrightSource).toContain("name: 'worker-stateful-chromium'")
    expect(playwrightSource).toContain('workers: 1')
  })

  it('starts fresh Wrangler processes in CI and runs stateful tests separately', () => {
    expect(playwrightSource).toContain('reuseExistingServer: !isCI && !isWorkerStatefulRun')
    expect(playwrightSource).toContain('PLAYWRIGHT_TEST_MODE:1')
    expect(ciSource.match(/npx playwright test/g)).toHaveLength(2)
    expect(ciSource).toContain('--project=worker-stateful-chromium')
    expect(ciSource).toContain("PLAYWRIGHT_WORKER_STATEFUL: '1'")
  })

  it('blocks accidental live Worker API calls from ordinary UI specs', () => {
    expect(uiFixturesSource).toContain('await page.route(/\\/api\\/v1\\//')
    expect(uiFixturesSource).toContain('worker-stateful.spec.ts')
    expect(statefulFixturesSource).toContain("request.post('/__test/tdx-state/reset')")
  })

  it('keeps state controls behind an explicit local-only binding', () => {
    expect(testRouteSource).toContain("PLAYWRIGHT_TEST_MODE === '1'")
    expect(testRouteSource).toContain("testState.post('/__test/tdx-state/reset'")
    expect(testRouteSource).toContain("testState.post('/__test/tdx-state/poison'")
  })
})
