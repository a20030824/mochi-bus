import type { RouteDetail } from '../lib/tdx'

export const ROUTE_IDENTITY_SCRIPT_ID = 'route-identity'

export type RoutePageIdentityStop = Pick<
  RouteDetail['stops'][number],
  'stopUid' | 'stopName' | 'sequence' | 'selected'
>

export type RoutePageIdentity = {
  schemaVersion: 1
  stops: RoutePageIdentityStop[]
}

export function toRoutePageIdentity(detail: RouteDetail): RoutePageIdentity {
  return {
    schemaVersion: 1,
    stops: detail.stops.map(({ stopUid, stopName, sequence, selected }) => ({
      stopUid,
      stopName,
      sequence,
      selected,
    })),
  }
}

/**
 * Attach an inert, versioned identity island to the server-rendered Route page.
 * The browser uses it to attest every DOM row before applying realtime ETA.
 */
export function embedRoutePageIdentity(html: string, detail: RouteDetail): string {
  const closingBody = '</body>'
  if (!html.includes(closingBody)) throw new Error('Route page HTML has no closing body tag')

  const payload = safeJSON(toRoutePageIdentity(detail))
  const island = `<script id="${ROUTE_IDENTITY_SCRIPT_ID}" type="application/json">${payload}</script>`
  return html.replace(closingBody, `${island}${closingBody}`)
}

function safeJSON(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
}
