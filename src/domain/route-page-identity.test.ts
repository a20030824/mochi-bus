import { describe, expect, it } from 'vitest'
import type { RouteDetail } from '../lib/tdx'
import { embedRoutePageIdentity, toRoutePageIdentity } from './route-page-identity'

const detail: RouteDetail = {
  routeName: '307',
  direction: 0,
  label: '板橋 → 撫遠街',
  stops: [
    { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false, etaLabel: null, etaTone: 'muted' },
    { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true, etaLabel: '更新中', etaTone: 'muted' },
  ],
}

describe('Route page identity island', () => {
  it('publishes only stable station identity fields', () => {
    expect(toRoutePageIdentity(detail)).toEqual({
      schemaVersion: 1,
      stops: [
        { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1, selected: false },
        { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2, selected: true },
      ],
    })
  })

  it('embeds inert JSON before the closing body tag', () => {
    const html = embedRoutePageIdentity('<!doctype html><body><main></main></body>', detail)

    expect(html).toContain('<script id="route-identity" type="application/json">')
    expect(html.indexOf('route-identity')).toBeLessThan(html.indexOf('</body>'))
    expect(html).not.toContain('etaLabel')
  })

  it('escapes station names that could close the script element', () => {
    const hostile: RouteDetail = {
      ...detail,
      stops: [{ ...detail.stops[0], stopName: '</script><script>globalThis.pwned=true</script>' }],
    }
    const html = embedRoutePageIdentity('<body></body>', hostile)

    expect(html).not.toContain('</script><script>globalThis.pwned=true</script>')
    expect(html).toContain('\\u003c/script\\u003e')
  })

  it('fails closed when the page shell has no body boundary', () => {
    expect(() => embedRoutePageIdentity('<main></main>', detail)).toThrow('closing body')
  })
})
