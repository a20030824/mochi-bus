import { describe, expect, it, vi } from 'vitest'
import type { BusQuery } from '../domain/bus-query'
import type { RouteMapVariant } from '../domain/map/map-model'
import type { TransitBindings } from '../infrastructure/transit/snapshot-repository'
import {
  buildSnapshotRouteDetail,
  getSnapshotRoutePage,
} from './snapshot-route-page'

const env = {} as TransitBindings

function variant(
  subRouteUid = 'SUB-A',
  stopUid = 'STOP-2',
): RouteMapVariant {
  return {
    variantKey: `PATTERN-${subRouteUid}`,
    routeName: '307',
    routeUid: 'ROUTE-A',
    subRouteUid,
    direction: 0,
    label: '板橋 → 撫遠街',
    subRouteName: subRouteUid,
    shape: {
      type: 'Feature',
      properties: { routeUid: 'ROUTE-A', direction: 0 },
      geometry: { type: 'LineString', coordinates: [[121, 25], [121.1, 25.1]] },
    },
    stops: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: { stopUid: 'STOP-3', stopName: '撫遠街', sequence: 3 },
          geometry: { type: 'Point', coordinates: [121.2, 25.2] },
        },
        {
          type: 'Feature',
          properties: { stopUid: 'STOP-1', stopName: '板橋公車站', sequence: 1 },
          geometry: { type: 'Point', coordinates: [121, 25] },
        },
        {
          type: 'Feature',
          properties: { stopUid, stopName: '捷運西門站', sequence: 2 },
          geometry: { type: 'Point', coordinates: [121.1, 25.1] },
        },
      ],
    },
    updatedAt: null,
  }
}

const query: BusQuery = {
  city: 'Taipei',
  routeName: '307',
  direction: 0,
  stopUid: 'STOP-2',
  stopName: '舊站名',
}

describe('buildSnapshotRouteDetail', () => {
  it('uses the normal ETA-free shell labels and deterministic station ordering', () => {
    const detail = buildSnapshotRouteDetail(variant(), 'STOP-2')

    expect(detail.stops.map((stop) => stop.stopUid)).toEqual(['STOP-1', 'STOP-2', 'STOP-3'])
    expect(detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '更新中',
      etaTone: 'muted',
    })
    expect(detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
    expect(detail.stops.some((stop) => stop.etaLabel === null || stop.etaLabel === '僅站序')).toBe(false)
  })
})

describe('getSnapshotRoutePage', () => {
  it('returns null without loading variants when StopUID is absent', async () => {
    const loadVariants = vi.fn(async () => [variant()])

    await expect(getSnapshotRoutePage(env, {
      ...query,
      stopUid: undefined,
    }, loadVariants)).resolves.toBeNull()
    expect(loadVariants).not.toHaveBeenCalled()
  })

  it('returns null when physical identity does not resolve to one variant', async () => {
    const loadVariants = vi.fn(async () => [
      variant('SUB-A'),
      variant('SUB-B'),
    ])

    await expect(getSnapshotRoutePage(env, query, loadVariants)).resolves.toBeNull()
  })

  it('loads, resolves, and builds one complete snapshot fallback page', async () => {
    const target = variant()
    const loadVariants = vi.fn(async () => [target])

    const page = await getSnapshotRoutePage(env, query, loadVariants)

    expect(loadVariants).toHaveBeenCalledWith(env, 'Taipei', '307')
    expect(page?.resolved).toMatchObject({
      routeUid: 'ROUTE-A',
      subRouteUid: 'SUB-A',
      stopUid: 'STOP-2',
      stopName: '捷運西門站',
    })
    expect(page?.detail).toMatchObject({
      routeName: '307',
      direction: 0,
      label: '板橋 → 撫遠街',
    })
    expect(page?.detail.stops.find((stop) => stop.selected)?.stopUid).toBe('STOP-2')
  })
})
