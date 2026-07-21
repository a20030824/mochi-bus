import { describe, expect, it } from 'vitest'
import { applyRouteShell } from '../../src/route-shell'

describe('applyRouteShell', () => {
  it('adds the Route browser entry and selected-stop alignment to HTML', async () => {
    const response = applyRouteShell(new Response(
      '<!doctype html><html><head></head><body><main class="route-page"></main></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ))

    const html = await response.text()
    expect(html).toContain('<main class="route-page"></main>')
    expect(html).toContain('<style>.route-stop>div{align-items:baseline}.route-stop.selected em{transform:translateY(1px)}</style>')
    expect(html).toContain('<script type="module" src="/assets/route.js"></script>')
  })

  it('leaves non-HTML responses untouched', async () => {
    const response = applyRouteShell(new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await response.text()).toBe('{"ok":true}')
  })
})
