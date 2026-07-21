/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import commuteSource from '../lib/tdx/commute-route-presentation.ts?raw'
import routeReadsSource from '../routes/map-route-reads.ts?raw'

describe('production error logging architecture boundary', () => {
  it('routes commute fallback diagnostics through the bounded object logger', () => {
    expect(commuteSource).toContain("event: 'commute_eta_realtime_failed'")
    expect(commuteSource).toContain("event: 'eta_schedule_fallback_failed'")
    expect(commuteSource.match(/logProductionError\(/g)).toHaveLength(2)
    expect(commuteSource).not.toContain('error instanceof Error ? error.message')
    expect(commuteSource).not.toContain("console.error('eta_schedule_fallback_failed', error)")
  })

  it('keeps route-map failures structured and excludes validation errors', () => {
    expect(routeReadsSource).toContain("event: 'route_map_failed'")
    expect(routeReadsSource).toContain("operation: 'map_route'")
    expect(routeReadsSource).toContain('error instanceof QueryValidationError || error instanceof ApiInputError')
    expect(routeReadsSource).not.toContain("console.error('route_map_failed', error)")
  })
})
