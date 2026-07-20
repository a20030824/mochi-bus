import { describe, expect, it } from 'vitest'
import { applyRouteShell } from './route-shell'

describe('applyRouteShell', () => {
  it('adds only the Route browser entry to HTML', async () => {
    const response = applyRouteShell(new Response(
      '<!doctype html><html><body><main class="route-page"></main></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ))

    const html = await response.text()
    expect(html).toContain('<main class="route-page"></main>')
    expect(html).toContain('<script type="module" src="/assets/route.js"></script>')
  })

  it('leaves non-HTML responses untouched', async () => {
    const response = applyRouteShell(new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await response.text()).toBe('{"ok":true}')
  })
})
