import { describe, expect, it, vi } from 'vitest'
import {
  logProductionError,
  productionFailureClass,
} from './production-log'

describe('production error log boundary', () => {
  it('emits one bounded object without messages, stacks, routes, or credentials', () => {
    const sink = vi.fn()
    const error = new Error('Bearer private-token for route 307')

    expect(logProductionError({
      event: 'route_map_failed',
      operation: 'map_route',
      city: 'Taipei',
      error,
    }, sink)).toBe(true)

    expect(sink).toHaveBeenCalledWith({
      event: 'route_map_failed',
      operation: 'map_route',
      city: 'Taipei',
      failureClass: 'unknown',
      errorType: 'Error',
    })
    const serialized = JSON.stringify(sink.mock.calls[0]?.[0])
    expect(serialized).not.toContain('private-token')
    expect(serialized).not.toContain('307')
    expect(serialized).not.toContain('stack')
    expect(serialized).not.toContain('message')
  })

  it('keeps only supported cities and allowlisted error types', () => {
    const sink = vi.fn()
    const error = Object.assign(new Error('hidden'), { name: 'UnboundedVendorFailure' })

    logProductionError({
      event: 'eta_schedule_fallback_failed',
      operation: 'bus_eta',
      city: 'NotARealCity',
      error,
    }, sink)

    expect(sink).toHaveBeenCalledWith(expect.objectContaining({
      city: null,
      errorType: 'Error',
    }))
  })

  it('classifies bounded TDX response and transport failures', () => {
    expect(productionFailureClass({ name: 'TDXServiceError', status: 503 })).toBe('upstream_5xx')
    expect(productionFailureClass({ name: 'TDXServiceError', status: 429 })).toBe('rate_limited')
    expect(productionFailureClass({
      name: 'TDXServiceError',
      cause: { name: 'TimeoutError' },
    })).toBe('timeout')
    expect(productionFailureClass({
      name: 'TDXServiceError',
      failureKind: 'tdx_invalid_json',
    })).toBe('tdx_invalid_json')
  })

  it('fails open when the logging sink throws', () => {
    expect(logProductionError({
      event: 'commute_eta_realtime_failed',
      operation: 'bus_eta',
      city: 'Taipei',
      error: new Error('hidden'),
    }, () => { throw new Error('sink failed') })).toBe(false)
  })
})
