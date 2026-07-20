export type RouteVariantPreviewStyle = {
  color: string
  weight: number
  opacity: number
  lineCap: 'round'
  lineJoin: 'round'
}

export function routeVariantPreviewStyle(color: string, index: number): RouteVariantPreviewStyle {
  return {
    color,
    weight: 5.5,
    opacity: index === 0 ? .62 : .3,
    lineCap: 'round',
    lineJoin: 'round',
  }
}

export function routeStopMarkerMetrics(zoom: number, prominent = false): { radius: number; weight: number } {
  if (prominent) return { radius: zoom >= 16 ? 11 : 9, weight: 2.4 }
  if (zoom >= 16) return { radius: 8, weight: 1.8 }
  if (zoom >= 13) return { radius: 5, weight: 1.4 }
  return { radius: 2, weight: 1 }
}

export function initialRouteStopMarkerMetrics(
  zoom: number,
  prominent = false,
): { radius: number; weight: number } {
  const metrics = routeStopMarkerMetrics(zoom, prominent)
  return { radius: metrics.radius, weight: prominent ? metrics.weight : 1.4 }
}

export function normalizedVehicleAzimuth(azimuth: number | null): number {
  return Number.isFinite(azimuth) ? azimuth as number : 0
}
