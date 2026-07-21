import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
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

// This handler owns the route-catalog fallback and telemetry contract. Snapshot persistence
// and TDX transport behavior remain behind their existing infrastructure boundaries.
export async function readRouteCatalog(c: Context<MapEnv>) {
  const tracker = beginMapOperation(c, 'map_routes', telemetryCity(c.req.query('city')?.trim()))
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')

    const snapshotRoutes = await getSnapshotRouteCatalog(c.env, city)
    const routes = snapshotRoutes.length ? snapshotRoutes : await getRouteCatalog(tdxEnv(c), city)
    const snapshotVersion = snapshotRoutes.length ? await getActiveSnapshotVersion(c.env, city) : null
    const response = c.json({
      schemaVersion: 2,
      city,
      source: snapshotRoutes.length ? 'snapshot' : 'tdx',
      snapshotVersion,
      routes,
    }, 200, {
      'Cache-Control': `public, max-age=${snapshotRoutes.length ? 86400 : 300}`,
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
