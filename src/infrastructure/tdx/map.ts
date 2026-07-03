import type { RouteMapVariant } from '../../domain/map/map-model'
import { polylineToGeoJSONCoordinates } from '../../domain/map/polyline'
import {
  fetchTDXJson,
  getRouteStopGroups,
  type TDXEnv,
} from '../../lib/tdx'

type ShapeItem = {
  RouteUID?: string
  Direction?: number
  EncodedPolyline?: string
  UpdateTime?: string
}

const SHAPE_CACHE_SECONDS = 6 * 60 * 60

export async function getRouteMapVariants(
  env: TDXEnv,
  city: string,
  routeName: string,
): Promise<RouteMapVariant[]> {
  const shapeUrl = new URL(
    `https://tdx.transportdata.tw/api/basic/v2/Bus/Shape/City/${encodeURIComponent(city)}/${encodeURIComponent(routeName)}`,
  )
  shapeUrl.searchParams.set('$format', 'JSON')

  const [groups, shapes] = await Promise.all([
    getRouteStopGroups(env, city, routeName),
    fetchTDXJson<ShapeItem[]>(env, shapeUrl, SHAPE_CACHE_SECONDS),
  ])

  const usedShapes = new Map<string, number>()
  const variants: RouteMapVariant[] = []

  for (const group of groups) {
    if (!group.routeUid) continue
    const identity = `${group.routeUid}:${group.direction}`
    const candidates = shapes.filter((shape) =>
      shape.RouteUID === group.routeUid
      && shape.Direction === group.direction
      && shape.EncodedPolyline,
    )
    const candidateIndex = usedShapes.get(identity) ?? 0
    const shape = candidates[candidateIndex] ?? candidates[0]
    usedShapes.set(identity, candidateIndex + 1)
    if (!shape?.EncodedPolyline) continue

    const positionedStops = group.stops.filter((stop) => stop.position)
    variants.push({
      variantKey: `${identity}:${candidateIndex}`,
      routeName,
      routeUid: group.routeUid,
      direction: group.direction,
      label: group.label,
      subRouteName: group.subRouteName,
      shape: {
        type: 'Feature',
        properties: { routeUid: group.routeUid, direction: group.direction },
        geometry: {
          type: 'LineString',
          coordinates: polylineToGeoJSONCoordinates(shape.EncodedPolyline),
        },
      },
      stops: {
        type: 'FeatureCollection',
        features: positionedStops.map((stop) => ({
          type: 'Feature',
          properties: {
            stopUid: stop.stopUid,
            stopName: stop.stopName,
            sequence: stop.sequence,
          },
          geometry: {
            type: 'Point',
            coordinates: [stop.position!.longitude, stop.position!.latitude],
          },
        })),
      },
      updatedAt: shape.UpdateTime ?? null,
    })
  }

  return variants
}
