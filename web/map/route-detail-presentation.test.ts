import { describe, expect, it } from 'vitest'
import {
  initialRouteStopMarkerMetrics,
  normalizedVehicleAzimuth,
  routeStopMarkerMetrics,
  routeVariantPreviewStyle,
  vehicleInfoText,
  vehicleUpdateAgeLabel,
} from './route-detail-presentation'

describe('route detail presentation policies', () => {
  it('keeps the first variant visually dominant while preserving shared geometry styling', () => {
    expect(routeVariantPreviewStyle('#123456', 0)).toEqual({
      color: '#123456',
      weight: 5.5,
      opacity: .62,
      lineCap: 'round',
      lineJoin: 'round',
    })
    expect(routeVariantPreviewStyle('#abcdef', 2).opacity).toBe(.3)
  })

  it('scales normal and prominent stop markers at the existing zoom thresholds', () => {
    expect(routeStopMarkerMetrics(12)).toEqual({ radius: 2, weight: 1 })
    expect(routeStopMarkerMetrics(13)).toEqual({ radius: 5, weight: 1.4 })
    expect(routeStopMarkerMetrics(16)).toEqual({ radius: 8, weight: 1.8 })
    expect(routeStopMarkerMetrics(15, true)).toEqual({ radius: 9, weight: 2.4 })
    expect(routeStopMarkerMetrics(16, true)).toEqual({ radius: 11, weight: 2.4 })
  })

  it('preserves the existing initial stroke before zoom resizing takes ownership', () => {
    expect(initialRouteStopMarkerMetrics(12)).toEqual({ radius: 2, weight: 1.4 })
    expect(initialRouteStopMarkerMetrics(16)).toEqual({ radius: 8, weight: 1.4 })
    expect(initialRouteStopMarkerMetrics(15, true)).toEqual({ radius: 9, weight: 2.4 })
  })

  it('normalizes missing or non-finite vehicle headings without changing valid headings', () => {
    expect(normalizedVehicleAzimuth(null)).toBe(0)
    expect(normalizedVehicleAzimuth(Number.NaN)).toBe(0)
    expect(normalizedVehicleAzimuth(275)).toBe(275)
  })

  it('formats vehicle data age without presenting unreliable speed', () => {
    const now = Date.parse('2026-07-20T10:00:00.000Z')
    const ago = (milliseconds: number) => new Date(now - milliseconds).toISOString()

    expect(vehicleUpdateAgeLabel(ago(5_000), now)).toBe('剛剛更新')
    expect(vehicleUpdateAgeLabel(ago(18_000), now)).toBe('18 秒前更新')
    expect(vehicleUpdateAgeLabel(ago(60_000), now)).toBe('1 分鐘前更新')
    expect(vehicleUpdateAgeLabel(ago(3_600_000), now)).toBe('1 小時前更新')
    expect(vehicleUpdateAgeLabel(ago(86_400_000), now)).toBe('1 天前更新')
    expect(vehicleUpdateAgeLabel('not-a-date', now)).toBe('更新時間未知')
    expect(vehicleUpdateAgeLabel(null, now)).toBe('更新時間未知')
    expect(vehicleInfoText(' KKA-1234 ', ago(18_000), now)).toBe('KKA-1234 · 18 秒前更新')
    expect(vehicleInfoText(null, null, now)).toBe('公車 · 更新時間未知')
  })
})
