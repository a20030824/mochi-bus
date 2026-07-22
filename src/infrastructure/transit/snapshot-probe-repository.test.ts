import { beforeEach, describe, expect, it } from 'vitest'
import { resetMemoryCacheForTests } from '../../lib/memory-cache'
import {
  getAuthoritativeActiveSnapshotVersion,
  getPinnedSnapshotRouteCatalog,
  getPinnedSnapshotRouteVariants,
  getPinnedStopPlaceBundle,
} from './snapshot-probe-repository'
import { getActiveSnapshotVersion, type TransitBindings } from './snapshot-repository'

const oldVersion = '20260720T204419330Z'
const candidateVersion = '20260722T101519183Z'

beforeEach(() => resetMemoryCacheForTests())

describe('snapshot probe repository', () => {
  it('reads authoritative D1 after the ordinary active-version cache is stale', async () => {
    let activeVersion = oldVersion
    const database = {
      prepare() {
        const statement = {
          bind: () => statement,
          first: async <T>() => ({ active_version: activeVersion }) as T,
        } as D1PreparedStatement
        return statement
      },
    } as D1Database
    const env: TransitBindings = {
      TRANSIT_DB: database,
      TRANSIT_SHAPES: {} as R2Bucket,
    }

    await expect(getActiveSnapshotVersion(env, 'Hsinchu')).resolves.toBe(oldVersion)
    activeVersion = candidateVersion

    await expect(getAuthoritativeActiveSnapshotVersion(env, 'Hsinchu')).resolves.toBe(candidateVersion)
    await expect(getActiveSnapshotVersion(env, 'Hsinchu')).resolves.toBe(oldVersion)
  })

  it('binds route catalogue, route detail, and place bundle reads to the requested version', async () => {
    const bindings: unknown[][] = []
    const database = {
      prepare(query: string) {
        const statement = {
          bind: (...values: unknown[]) => {
            bindings.push(values)
            return statement
          },
          all: async <T>() => ({
            success: true,
            results: (query.includes('FROM patterns p')
              ? [{
                  pattern_id: 'HSZ000701:0:0',
                  route_uid: 'HSZ000701',
                  subroute_uid: 'HSZ0007010',
                  route_name: '藍1區',
                  subroute_name: '藍1區',
                  direction: 0,
                  departure_name: 'A',
                  destination_name: 'B',
                  shape_key: `snapshots/${candidateVersion}/cities/Hsinchu/shapes/HSZ000701:0:0.json`,
                  updated_at: null,
                }]
              : query.includes('FROM pattern_stops ps')
                ? [
                    { stop_uid: 'S1', stop_name: '一站', stop_sequence: 1, latitude: 24.8, longitude: 120.9 },
                    { stop_uid: 'S2', stop_name: '二站', stop_sequence: 2, latitude: 24.81, longitude: 120.91 },
                  ]
                : [{
                    route_uid: 'HSZ000701',
                    route_name: '藍1區',
                    departure_name: 'A',
                    destination_name: 'B',
                  }]) as T[],
          }),
        } as D1PreparedStatement
        return statement
      },
    } as D1Database
    const bundle = {
      version: candidateVersion,
      placeId: 'Hsinchu:1ifw3fu',
      name: '一站',
      routes: [],
    }
    const reads: string[] = []
    const bucket = {
      async get(key: string) {
        reads.push(key)
        if (key.includes('/shapes/')) {
          return {
            json: async <T>() => ({
              type: 'Feature',
              properties: {},
              geometry: { type: 'LineString', coordinates: [[120.9, 24.8], [120.91, 24.81]] },
            }) as T,
          } as R2ObjectBody
        }
        if (key.includes('/places/')) {
          return { json: async <T>() => bundle as T } as R2ObjectBody
        }
        return null
      },
    } as unknown as R2Bucket
    const env: TransitBindings = { TRANSIT_DB: database, TRANSIT_SHAPES: bucket }

    const routes = await getPinnedSnapshotRouteCatalog(env, 'Hsinchu', candidateVersion)
    const variants = await getPinnedSnapshotRouteVariants(env, 'Hsinchu', '藍1區', candidateVersion)
    const place = await getPinnedStopPlaceBundle(env, 'Hsinchu', 'Hsinchu:1ifw3fu', candidateVersion)

    expect(routes).toHaveLength(1)
    expect(variants).toHaveLength(1)
    expect(variants[0].variantKey).toBe('HSZ000701:0:0')
    expect(variants[0].stops.features).toHaveLength(2)
    expect(place).toEqual(bundle)
    expect(bindings).toContainEqual([candidateVersion, 'Hsinchu'])
    expect(bindings).toContainEqual([candidateVersion, 'Hsinchu', '藍1區'])
    expect(bindings).toContainEqual([candidateVersion, 'HSZ000701:0:0'])
    expect(reads).toContain(`snapshots/${candidateVersion}/cities/Hsinchu/places/Hsinchu:1ifw3fu.json`)
    expect(reads.every((key) => key.includes(candidateVersion))).toBe(true)
  })
})
