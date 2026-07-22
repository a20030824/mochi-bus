import { describe, expect, it, vi } from 'vitest'
import type { TransitBindings } from './snapshot-repository'
import { getPinnedSnapshotRouteVariant } from './snapshot-probe-repository'

const version = '20260722T111540779Z'
const city = 'Hsinchu'
const exactPattern = {
  pattern_id: 'HSZ001234:0:0',
  route_uid: 'HSZ001234',
  subroute_uid: 'HSZ0012340',
  route_name: '同名路線',
  subroute_name: '同名路線',
  direction: 0 as const,
  departure_name: '甲站',
  destination_name: '乙站',
  shape_key: `snapshots/${version}/cities/${city}/shapes/HSZ001234:0:0.json`,
  updated_at: null,
}

function bindings({
  pattern = exactPattern,
  shape = {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates: [[120.9, 24.8], [120.91, 24.81]] },
  },
  stops = [
    { stop_uid: 'S1', stop_name: '甲站', stop_sequence: 1, latitude: 24.8, longitude: 120.9 },
    { stop_uid: 'S2', stop_name: '乙站', stop_sequence: 2, latitude: 24.81, longitude: 120.91 },
  ],
  shapeError,
}: {
  pattern?: typeof exactPattern | null
  shape?: object | null
  stops?: Array<Record<string, string | number>>
  shapeError?: Error
} = {}) {
  const bindingsSeen: unknown[][] = []
  const shapeReads: string[] = []
  const database = {
    prepare(query: string) {
      const statement = {
        bind: (...values: unknown[]) => {
          bindingsSeen.push(values)
          return statement
        },
        first: async <T>() => pattern as T,
        all: async <T>() => ({ success: true, results: (query.includes('FROM pattern_stops ps') ? stops : []) as T[] }),
      } as D1PreparedStatement
      return statement
    },
  } as unknown as D1Database
  const bucket = {
    async get(key: string) {
      shapeReads.push(key)
      if (shape === null) return null
      return {
        json: async <T>() => {
          if (shapeError) throw shapeError
          return shape as T
        },
      } as R2ObjectBody
    },
  } as unknown as R2Bucket
  return {
    env: { TRANSIT_DB: database, TRANSIT_SHAPES: bucket } as TransitBindings,
    bindingsSeen,
    shapeReads,
  }
}

describe('exact pinned snapshot route repository', () => {
  it('reads only the requested route UID and pattern even when the route name is shared', async () => {
    const fixture = bindings()

    const variant = await getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )

    expect(variant).toMatchObject({
      variantKey: exactPattern.pattern_id,
      routeUid: exactPattern.route_uid,
      routeName: exactPattern.route_name,
    })
    expect(variant?.stops.features).toHaveLength(2)
    expect(fixture.bindingsSeen).toContainEqual([
      version,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
    ])
    expect(fixture.shapeReads).toEqual([exactPattern.shape_key])
    expect(fixture.shapeReads).not.toContain(
      `snapshots/${version}/cities/${city}/shapes/OTHER_ROUTE_SAME_NAME:0:0.json`,
    )
  })

  it('fails closed before R2 when route UID and pattern ID do not identify one row', async () => {
    const fixture = bindings({ pattern: null })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      'HSZ_OTHER',
      exactPattern.pattern_id,
      version,
    )).resolves.toBeNull()
    expect(fixture.shapeReads).toEqual([])
  })

  it('fails closed when the exact sample shape is missing', async () => {
    const fixture = bindings({ shape: null })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).resolves.toBeNull()
  })

  it('fails closed when the exact sample shape JSON is invalid', async () => {
    const fixture = bindings({ shapeError: new SyntaxError('private shape body') })

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).rejects.toThrow(SyntaxError)
  })

  it('returns the exact short stop list so the active probe can reject it', async () => {
    const fixture = bindings({
      stops: [{ stop_uid: 'S1', stop_name: '甲站', stop_sequence: 1, latitude: 24.8, longitude: 120.9 }],
    })

    const variant = await getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )
    expect(variant?.stops.features).toHaveLength(1)
  })

  it('does not read an unrelated same-name shape when that artifact is invalid', async () => {
    const fixture = bindings()
    const get = vi.spyOn(fixture.env.TRANSIT_SHAPES, 'get')

    await expect(getPinnedSnapshotRouteVariant(
      fixture.env,
      city,
      exactPattern.route_uid,
      exactPattern.pattern_id,
      version,
    )).resolves.toMatchObject({ variantKey: exactPattern.pattern_id })
    expect(get).toHaveBeenCalledTimes(1)
    expect(get).toHaveBeenCalledWith(exactPattern.shape_key)
  })
})
