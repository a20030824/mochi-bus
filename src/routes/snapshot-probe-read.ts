import type { Context } from 'hono'
import { getAuthoritativeActiveSnapshotVersion } from '../infrastructure/transit/snapshot-probe-repository'
import { ApiInputError, optionalQueryString } from '../lib/api-input'
import type { MapEnv } from './map-http-context'

const SNAPSHOT_VERSION = /^\d{8}T\d{9}Z$/
const PROBE_WINDOW = /^v1:([A-Za-z0-9]+):\d{4}-\d{2}-\d{2}:(?:manual|\d{4})$/
const ROUTE_UID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/
const PATTERN_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

export type RequestedProbeRouteIdentity = {
  routeUid: string
  patternId: string
}

// The snapshot query does not grant access to historical data. It is accepted
// only when the requested version is exactly the uncached D1 active pointer.
// `probe` is optional because the older first-layer publisher smoke sends only
// `snapshot`; when present it must be the bounded window identity for this city.
export async function requestedProbeSnapshotVersion(
  c: Context<MapEnv>,
  city: string,
): Promise<string | undefined> {
  const requested = optionalQueryString(c.req.query('snapshot'), 'snapshot', 128)
  const probe = optionalQueryString(c.req.query('probe'), 'probe', 128)
  if (!requested && !probe) return undefined
  if (!requested || !SNAPSHOT_VERSION.test(requested)) invalidProbeRead()
  const probeMatch = probe?.match(PROBE_WINDOW)
  if (probe && (!probeMatch || probeMatch[1] !== city)) invalidProbeRead()

  const activeVersion = await getAuthoritativeActiveSnapshotVersion(c.env, city)
  if (activeVersion !== requested) invalidProbeRead()
  return requested
}

// Exact route identity is a publish-probe-only contract. Snapshot-only publisher
// smoke requests keep the grouped route-name behavior, while ordinary callers
// cannot use these selectors to browse active or historical snapshot variants.
export function requestedProbeRouteIdentity(
  c: Context<MapEnv>,
  requestedVersion: string | undefined,
): RequestedProbeRouteIdentity | undefined {
  const routeUid = optionalQueryString(c.req.query('routeUid'), 'RouteUID', 100)
  const patternId = optionalQueryString(c.req.query('patternId'), 'PatternID', 200)
  if (!routeUid && !patternId) return undefined
  if (!requestedVersion || !c.req.query('probe')) invalidProbeRead()
  if (!routeUid || !patternId || !ROUTE_UID.test(routeUid) || !PATTERN_ID.test(patternId)) invalidProbeRead()
  return { routeUid, patternId }
}

function invalidProbeRead(): never {
  throw new ApiInputError(400, 'INVALID_QUERY', '指定快照目前不可用')
}
