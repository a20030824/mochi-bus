import type { BusQuery, ResolvedBusQuery } from '../domain/bus-query'
import { getRoutePageDetail } from '../domain/route-page-detail'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  resolveBusQuery,
  type RouteDetail,
  type TDXEnv,
} from '../lib/tdx'
import { getSnapshotRoutePage } from './snapshot-route-page'

export type RoutePage = {
  resolved: ResolvedBusQuery
  detail: RouteDetail
}

export type RoutePageSources = {
  tdx: TDXEnv
  snapshot: TransitBindings
}

type RoutePageDependencies = {
  resolveBusQuery: typeof resolveBusQuery
  getRoutePageDetail: typeof getRoutePageDetail
  getSnapshotRoutePage: typeof getSnapshotRoutePage
  reportSnapshotFailure: (error: unknown) => void
}

const defaultDependencies: RoutePageDependencies = {
  resolveBusQuery,
  getRoutePageDetail,
  getSnapshotRoutePage,
  reportSnapshotFailure: (error) => console.error('route_snapshot_fallback_failed', error),
}

/**
 * Resolve a Route page from TDX first, then fail over to the static snapshot.
 * A missing or broken snapshot must never replace the original primary error,
 * because that error determines the public status code and message.
 */
export async function getRoutePageWithFallback(
  sources: RoutePageSources,
  query: BusQuery,
  dependencies: Partial<RoutePageDependencies> = {},
): Promise<RoutePage> {
  const resolvedDependencies: RoutePageDependencies = {
    ...defaultDependencies,
    ...dependencies,
  }

  try {
    const resolved = await resolvedDependencies.resolveBusQuery(sources.tdx, query)
    const { detail } = await resolvedDependencies.getRoutePageDetail(sources.tdx, resolved)
    return { resolved, detail }
  } catch (primaryError) {
    try {
      const fallback = await resolvedDependencies.getSnapshotRoutePage(sources.snapshot, query)
      if (fallback) return fallback
    } catch (snapshotError) {
      try {
        resolvedDependencies.reportSnapshotFailure(snapshotError)
      } catch {
        // Logging failures must not replace the original Route page failure.
      }
    }
    throw primaryError
  }
}
