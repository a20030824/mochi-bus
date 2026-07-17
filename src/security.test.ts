import { describe, expect, it, vi } from 'vitest'
import app from './index'
import { cspViolationSummaries, httpsRedirectTarget, securityHeaders } from './security'

describe('HTTPS enforcement', () => {
  it('redirects public HTTP URLs to the equivalent HTTPS URL', () => {
    expect(httpsRedirectTarget('http://bus.moc96336.com/api/v1/map/cities?lang=zh-TW'))
      .toBe('https://bus.moc96336.com/api/v1/map/cities?lang=zh-TW')
  })

  it('does not redirect HTTPS or local development URLs', () => {
    expect(httpsRedirectTarget('https://bus.moc96336.com/')).toBeNull()
    expect(httpsRedirectTarget('http://localhost:8787/')).toBeNull()
    expect(httpsRedirectTarget('http://worker.localhost:8787/')).toBeNull()
    expect(httpsRedirectTarget('http://127.0.0.1:8787/')).toBeNull()
  })

  it('returns a permanent redirect before route bindings are accessed', async () => {
    const response = await app.request('http://bus.moc96336.com/api/v1/map/cities?lang=zh-TW')

    expect(response.status).toBe(308)
    expect(response.headers.get('location'))
      .toBe('https://bus.moc96336.com/api/v1/map/cities?lang=zh-TW')
    expect(response.headers.get('strict-transport-security')).toBeNull()
  })
})

describe('security headers', () => {
  it('uses a staged HSTS policy only for HTTPS responses', () => {
    expect(securityHeaders(true)['Strict-Transport-Security']).toBe('max-age=86400')
    expect(securityHeaders(true)['Strict-Transport-Security']).not.toContain('includeSubDomains')
    expect(securityHeaders(true)['Strict-Transport-Security']).not.toContain('preload')
    expect(securityHeaders(false)['Strict-Transport-Security']).toBeUndefined()
  })

  it('adds the global security baseline to successful responses', async () => {
    const response = await app.request('https://bus.moc96336.com/api/v1/map/cities')

    expect(response.status).toBe(200)
    expect(response.headers.get('strict-transport-security')).toBe('max-age=86400')
    expect(response.headers.get('strict-transport-security')).not.toContain('includeSubDomains')
    expect(response.headers.get('strict-transport-security')).not.toContain('preload')
    expect(response.headers.get('content-security-policy'))
      .toBe("base-uri 'self'; frame-ancestors 'none'; object-src 'none'")
    expect(response.headers.get('content-security-policy-report-only'))
      .toContain("default-src 'self'; base-uri 'self'; connect-src 'self' https://tdx.transportdata.tw")
    expect(response.headers.get('content-security-policy-report-only'))
      .toContain('report-uri /api/v1/csp-report; report-to csp')
    expect(response.headers.get('reporting-endpoints'))
      .toBe('csp="https://bus.moc96336.com/api/v1/csp-report"')
    expect(response.headers.get('permissions-policy'))
      .toBe('camera=(), geolocation=(self), microphone=(), payment=(), usb=()')
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })

  it('reduces CSP reports to bounded fields without retaining paths, queries, or samples', () => {
    const summaries = cspViolationSummaries({
      'csp-report': {
        'effective-directive': 'connect-src',
        'blocked-uri': 'https://unexpected.example/private?secret=client-secret',
        'source-file': 'https://bus.moc96336.com/assets/map.js?Authorization=Bearer-token',
        'script-sample': 'Client Secret should never reach logs',
        disposition: 'report',
        'status-code': 200,
      },
    })

    expect(summaries).toEqual([{
      directive: 'connect-src',
      blocked: 'https://unexpected.example',
      source: 'https://bus.moc96336.com',
      disposition: 'report',
      statusCode: 200,
    }])
    expect(JSON.stringify(summaries)).not.toMatch(/client-secret|Authorization|Bearer-token|script-sample/)
  })

  it('accepts bounded CSP reports without echoing their body', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const response = await app.request('https://bus.moc96336.com/api/v1/csp-report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/csp-report' },
      body: JSON.stringify({ 'csp-report': { 'effective-directive': 'img-src', 'blocked-uri': 'data' } }),
    })

    expect(response.status).toBe(204)
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(await response.text()).toBe('')
    expect(warn).toHaveBeenCalledWith(JSON.stringify({
      message: 'csp_violation',
      directive: 'img-src',
      blocked: 'data',
      source: 'unknown',
    }))
    warn.mockRestore()
  })

  it('preserves a stricter route-specific referrer policy', async () => {
    const response = await app.request('https://bus.moc96336.com/setup')

    expect(response.status).toBe(200)
    expect(response.headers.get('referrer-policy')).toBe('no-referrer')
  })

  it('keeps local HTTP usable without sending an ineffective HSTS header', async () => {
    const response = await app.request('http://localhost:8787/not-found')

    expect(response.status).toBe(404)
    expect(response.headers.get('strict-transport-security')).toBeNull()
    expect(response.headers.get('x-frame-options')).toBe('DENY')
  })
})
