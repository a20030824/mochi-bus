import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import { findNearbyStopPlaces, getCityNetwork, type TransitBindings } from './snapshot-repository'

type StopPlaceRow = {
  place_id: string
  place_name: string
  latitude: number
  longitude: number
}

describe('findNearbyStopPlaces', () => {
  beforeEach(() => resetMemoryCacheForTests())

  it('ranks the complete bounding-box result before taking the nearest 100', async () => {
    const latitude = 23.5
    const longitude = 120.5
    const candidates: StopPlaceRow[] = Array.from({ length: 100 }, (_, index) => ({
      place_id: `far-${index.toString().padStart(3, '0')}`,
      place_name: `Far ${index}`,
      latitude: latitude + 0.005 + index * 0.000001,
      longitude,
    }))
    candidates.push({
      place_id: 'closest-after-first-100',
      place_name: 'Closest',
      latitude: latitude + 0.00001,
      longitude,
    })

    const queries: string[] = []
    const meta = {
      duration: 0,
      size_after: 0,
      rows_read: candidates.length,
      rows_written: 0,
      last_row_id: 0,
      changed_db: false,
      changes: 0,
    }
    const database = {
      prepare(query: string) {
        queries.push(query)
        function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
        function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
        async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
          return options?.columnNames ? [[]] as [string[], ...T[]] : []
        }
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async <T = Record<string, unknown>>() => ({ active_version: 'v1' }) as T,
          all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: candidates as T[],
          }),
          run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: [],
          }),
          raw,
        }
        return statement
      },
    } as D1Database
    const env: TransitBindings = {
      TRANSIT_DB: database,
      TRANSIT_SHAPES: {} as R2Bucket,
    }

    const places = await findNearbyStopPlaces(env, 'DenseCity', latitude, longitude, 2_000)
    const nearbyQuery = queries.find((query) => query.includes('FROM stop_places'))

    expect(nearbyQuery).toBeDefined()
    expect(nearbyQuery).not.toMatch(/\bLIMIT\b/i)
    expect(places).toHaveLength(100)
    expect(places[0].placeId).toBe('closest-after-first-100')
    expect(places.some((place) => place.placeId === 'closest-after-first-100')).toBe(true)
  })
})

describe('getCityNetwork', () => {
  beforeEach(() => resetMemoryCacheForTests())

  it('簡化小城市 inline fallback 的 shape 座標(PERF-001 LOD),不動起訖點', async () => {
    const meta = {
      duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0,
    }
    const patternRow = {
      pattern_id: 'P1', route_uid: 'R1', subroute_uid: null, route_name: 'Route 1',
      subroute_name: 'Route 1', direction: 0 as const, departure_name: 'A', destination_name: 'B',
      shape_key: 'shapes/P1.json', updated_at: null,
    }
    const database = {
      prepare(query: string) {
        function raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>
        function raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>
        async function raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<[string[], ...T[]] | T[]> {
          return options?.columnNames ? [[]] as [string[], ...T[]] : []
        }
        const statement: D1PreparedStatement = {
          bind: () => statement,
          first: async <T = Record<string, unknown>>() => ({ active_version: 'v1' }) as T,
          all: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({
            success: true,
            meta,
            results: (query.includes('FROM patterns') ? [patternRow] : []) as T[],
          }),
          run: async <T = Record<string, unknown>>(): Promise<D1Result<T>> => ({ success: true, meta, results: [] }),
          raw,
        }
        return statement
      },
    } as D1Database
    // 幾乎一直線,中間點偏離起訖連線遠小於 50m 容差,應該被簡化掉。
    const shapeFeature = {
      type: 'Feature' as const,
      properties: {},
      geometry: {
        type: 'LineString' as const,
        coordinates: [[121, 25], [121.0005, 25.00005], [121.001, 25]] as [number, number][],
      },
    }
    const bucket = {
      async get(key: string) {
        if (key === 'shapes/P1.json') return { json: async <T>() => shapeFeature as T } as unknown as R2ObjectBody
        return null
      },
    } as unknown as R2Bucket
    const env: TransitBindings = { TRANSIT_DB: database, TRANSIT_SHAPES: bucket }

    const result = await getCityNetwork(env, 'SmallCity')

    if (result?.kind !== 'inline') throw new Error('expected inline fallback result')
    expect(result.network.routes).toHaveLength(1)
    expect(result.network.routes[0].shape.geometry.coordinates).toEqual([[121, 25], [121.001, 25]])
  })
})
