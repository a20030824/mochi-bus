import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { getPinnedSnapshotRouteCatalog } from '../infrastructure/transit/snapshot-probe-repository'
import {
  getActiveSnapshotVersion,
  getSnapshotRouteCatalog,
} from '../infrastructure/transit/snapshot-repository'
import { getRouteCatalog } from '../lib/tdx'
import { mapRoutesOutcome } from '../observability/map-api-outcomes'
import {
  beginMapOperation,
  completeMapError,
  tdxEnv,
  telemetryCity,
  type MapEnv,
} from './map-http-context'
import { requestedProbeSnapshotVersion } from './snapshot-probe-read'

// Own the route-catalog fallback, response, cache, and telemetry contract here;
// snapshot persistence and TDX transport stay behind their infrastructure boundaries.
export async function readRouteCatalog(c: Context<MapEnv>) {
  const tracker = beginMapOperation(c, 'map_routes', telemetryCity(c.req.query('city')?.trim()))
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')

    const requestedVersion = await requestedProbeSnapshotVersion(c, city)
    const snapshotRoutes = requestedVersion
      ? await getPinnedSnapshotRouteCatalog(c.env, city, requestedVersion)
      : await getSnapshotRouteCatalog(c.env, city)
    const usesSnapshot = requestedVersion !== undefined || snapshotRoutes.length > 0
    const routes = usesSnapshot ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    const snapshotVersion = requestedVersion
      ?? (snapshotRoutes.length ? await getActiveSnapshotVersion(c.env, city) : null)
    const response = c.json({
      schemaVersion: 2,
      city,
      source: usesSnapshot ? 'snapshot' : 'tdx',
      snapshotVersion,
      routes,
    }, 200, {
      'Cache-Control': requestedVersion
        ? 'no-store'
        : `public, max-age=${usesSnapshot ? 86400 : 300}`,
    })
    tracker.complete({
      ...mapRoutesOutcome({
        snapshotRouteCount: snapshotRoutes.length,
        routeCount: routes.length,
        snapshotVersion,
      }),
      httpStatus: 200,
      city: telemetryCity(city),
    })
    return response
  } catch (error) {
    return completeMapError(c, tracker, error, '路線目錄讀取失敗')
  }
}
