import { describe, expect, it } from 'vitest'
import {
  canonicalMapHistoryState,
  mapViewFromUrl,
  planInitialMapHistory,
  readMapView,
} from './history-state'

const cities = [
  { code: 'Taipei', region: 'north' },
  { code: 'Kaohsiung', region: 'south' },
]
const validRegions = new Set(['north', 'south'])

describe('map history state', () => {
  it('derives the visible map view from shareable URL state', () => {
    expect(mapViewFromUrl(new URLSearchParams())).toBe('overview')
    expect(mapViewFromUrl(new URLSearchParams('region=north'))).toBe('region')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei'))).toBe('catalogue')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&route=307'))).toBe('route')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&stopUid=TPE1'))).toBe('place')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&lat=25&lon=121'))).toBe('nearby')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&trip=select'))).toBe('trip-select')
    expect(mapViewFromUrl(new URLSearchParams('city=Taipei&trip=results'))).toBe('trip-results')
  })

  it('accepts only known views from browser history', () => {
    expect(readMapView({ mapView: 'route' })).toBe('route')
    expect(readMapView({ mapView: 'unknown' })).toBeUndefined()
    expect(readMapView([])).toBeUndefined()
  })

  it('canonicalizes history while preserving unrelated view state', () => {
    const canonical = canonicalMapHistoryState(
      { mapView: 'catalogue', mapParent: 'region', routeScrollTop: 240 },
      new URLSearchParams('city=Taipei&route=307'),
    )
    expect(canonical).toEqual({
      view: 'route',
      state: { mapView: 'route', mapParent: 'catalogue', routeScrollTop: 240 },
      changed: true,
    })
  })

  it('removes a stale parent from the overview state', () => {
    const canonical = canonicalMapHistoryState(
      { mapView: 'route', mapParent: 'catalogue', marker: 'keep' },
      new URLSearchParams(),
    )
    expect(canonical.state).toEqual({ mapView: 'overview', marker: 'keep' })
  })

  it('does not rewrite an already canonical state', () => {
    expect(canonicalMapHistoryState(
      { mapView: 'place', mapParent: 'catalogue' },
      new URLSearchParams('city=Taipei&place=p1'),
    ).changed).toBe(false)
  })

  it('plans the complete browser history chain for a route deep link', () => {
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('city=Taipei&route=307'),
      cities,
      validRegions,
      originalUrl: '/map?city=Taipei&route=307',
    })).toEqual([
      { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
      { mode: 'push', state: { mapView: 'region', mapParent: 'overview' }, url: '/map?region=north' },
      { mode: 'push', state: { mapView: 'catalogue', mapParent: 'region' }, url: '/map?city=Taipei' },
      { mode: 'push', state: { mapView: 'route', mapParent: 'catalogue' }, url: '/map?city=Taipei&route=307' },
    ])
  })

  it('keeps region deep links shallow and ignores unknown cities', () => {
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('region=south'),
      cities,
      validRegions,
      originalUrl: '/map?region=south',
    })).toHaveLength(2)
    expect(planInitialMapHistory({
      state: null,
      params: new URLSearchParams('city=Unknown&route=1'),
      cities,
      validRegions,
      originalUrl: '/map?city=Unknown&route=1',
    })).toEqual([
      { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
    ])
  })

  it('leaves an existing map history chain untouched', () => {
    expect(planInitialMapHistory({
      state: { mapView: 'nearby', mapParent: 'catalogue' },
      params: new URLSearchParams('city=Taipei&lat=25&lon=121'),
      cities,
      validRegions,
      originalUrl: '/map?city=Taipei&lat=25&lon=121',
    })).toEqual([])
  })
})
