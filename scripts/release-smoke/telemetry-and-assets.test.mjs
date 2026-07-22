import { describe, expect, it, vi } from 'vitest'
import { parseTelemetryEvent } from '../../src/observability/telemetry.ts'
import {
  createReleaseSmokeEvent,
  discoverAssetGraph,
} from './post-deploy.mjs'

const releaseSha = '0123456789abcdef0123456789abcdef01234567'

describe('production bundle discovery', () => {
  it('discovers minified static import and re-export chunks', async () => {
    const bodies = new Map([
      ['/assets/map.js', {
        contentType: 'text/javascript',
        body: 'import{a as b}from"./shared-a1b2c3.js";export{c}from"./route-d4e5f6.js";',
      }],
      ['/assets/shared-a1b2c3.js', { contentType: 'text/javascript', body: 'export const a=1' }],
      ['/assets/route-d4e5f6.js', { contentType: 'text/javascript', body: 'export const c=2' }],
    ])
    const readAsset = vi.fn(async (path) => bodies.get(path))

    await expect(discoverAssetGraph({
      html: '<script type="module" src="/assets/map.js"></script>',
      readAsset,
    })).resolves.toEqual([
      '/assets/map.js',
      '/assets/shared-a1b2c3.js',
      '/assets/route-d4e5f6.js',
    ])
  })
})

describe('release smoke telemetry', () => {
  it('creates an A1-compatible success event', () => {
    const event = createReleaseSmokeEvent({
      result: 'success',
      releaseSha,
      workerVersionId: 'worker-version-1',
      workerCreatedAt: '2026-07-22T16:30:00.000Z',
      durationMs: 620_000,
    })

    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event).toMatchObject({
      eventSchema: 7,
      event: 'release_smoke_completed',
      operation: 'release_smoke',
      result: 'success',
      source: 'worker',
      trafficClass: 'synthetic',
      sampleProbability: 1,
      failureClass: 'none',
    })
  })

  it('maps detailed bounded failures into the existing telemetry failure taxonomy', () => {
    const event = createReleaseSmokeEvent({
      result: 'error',
      releaseSha,
      workerVersionId: null,
      workerCreatedAt: null,
      durationMs: 5_000,
      failureClass: 'browser_console_error',
    })

    expect(parseTelemetryEvent(event)).toEqual(event)
    expect(event.failureClass).toBe('bootstrap')
    expect(JSON.stringify(event)).not.toMatch(/url|query|message|stack|token|secret/i)
  })
})
