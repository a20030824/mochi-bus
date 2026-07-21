import { describe, expect, it } from 'vitest'
import { applyAppearanceShell } from '../../src/appearance-shell'

describe('applyAppearanceShell', () => {
  it('injects appearance bootstrap and shared interface alignment before paint', async () => {
    const response = applyAppearanceShell(new Response(
      '<!doctype html><html><head></head><body><main></main></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    ))

    const html = await response.text()
    expect(html).toContain('id="mochi-appearance-overrides"')
    expect(html).toContain('id="mochi-interface-alignment"')
    expect(html).toContain('.route-stop > div,')
    expect(html).toContain('.board-title-line,')
    expect(html).toContain('.nearby-place-button,')
    expect(html).toContain('.place-route-main > .place-route-eta')
    expect(html).toContain('<script type="module" src="/assets/appearance.js"></script>')
  })

  it('leaves non-HTML responses untouched', async () => {
    const response = applyAppearanceShell(new Response('{"ok":true}', {
      headers: { 'Content-Type': 'application/json' },
    }))

    expect(await response.text()).toBe('{"ok":true}')
  })
})
