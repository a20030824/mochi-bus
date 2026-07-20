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

export function vehicleUpdateAgeLabel(gpsTime: string | null, now = Date.now()): string {
  if (!gpsTime) return '更新時間未知'
  const updatedAt = Date.parse(gpsTime)
  if (!Number.isFinite(updatedAt)) return '更新時間未知'

  const ageSeconds = Math.max(0, Math.floor((now - updatedAt) / 1_000))
  if (ageSeconds < 10) return '剛剛更新'
  if (ageSeconds < 60) return `${ageSeconds} 秒前更新`

  const ageMinutes = Math.floor(ageSeconds / 60)
  if (ageMinutes < 60) return `${ageMinutes} 分鐘前更新`

  const ageHours = Math.floor(ageMinutes / 60)
  if (ageHours < 24) return `${ageHours} 小時前更新`
  return `${Math.floor(ageHours / 24)} 天前更新`
}

export function vehicleInfoText(plate: string | null, gpsTime: string | null, now = Date.now()): string {
  return `${plate?.trim() || '公車'} · ${vehicleUpdateAgeLabel(gpsTime, now)}`
}
