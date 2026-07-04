import type { RouteMapVariant } from '../../domain/map/map-model'
import { classifyRouteName } from '../../domain/route-category'

type ActiveVersion = { active_version: string }
type PatternRow = {
  pattern_id: string
  route_uid: string
  route_name: string
  subroute_name: string
  direction: 0 | 1
  departure_name: string
  destination_name: string
  shape_key: string
  updated_at: string | null
}
type StopRow = {
  stop_uid: string
  stop_name: string
  stop_sequence: number
  latitude: number
  longitude: number
}
type ShapeFeature = RouteMapVariant['shape']

export type TransitBindings = {
  TRANSIT_DB: D1Database
  TRANSIT_SHAPES: R2Bucket
}

export async function getSnapshotRouteVariants(
  env: TransitBindings,
  city: string,
  routeName: string,
): Promise<RouteMapVariant[]> {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return []

  const patterns = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, r.route_name, p.subroute_name, p.direction,
           p.departure_name, p.destination_name, p.shape_key, p.updated_at
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND r.route_name = ?
    ORDER BY p.direction, p.pattern_id
  `).bind(active.active_version, city, routeName).all<PatternRow>()
  if (!patterns.results.length) return []

  return (await Promise.all(patterns.results.map(async (pattern) => {
    const [stops, shapeObject] = await Promise.all([
      env.TRANSIT_DB.prepare(`
        SELECT s.stop_uid, s.stop_name, ps.stop_sequence, s.latitude, s.longitude
        FROM pattern_stops ps
        JOIN stops s ON s.version = ps.version AND s.stop_uid = ps.stop_uid
        WHERE ps.version = ? AND ps.pattern_id = ?
        ORDER BY ps.stop_sequence
      `).bind(active.active_version, pattern.pattern_id).all<StopRow>(),
      env.TRANSIT_SHAPES.get(pattern.shape_key),
    ])
    if (!shapeObject) return null
    const shape = await shapeObject.json<ShapeFeature>()
    return {
      variantKey: pattern.pattern_id,
      routeName: pattern.route_name,
      routeUid: pattern.route_uid,
      direction: pattern.direction,
      label: `${pattern.departure_name} → ${pattern.destination_name}`,
      subRouteName: pattern.subroute_name,
      shape,
      stops: {
        type: 'FeatureCollection' as const,
        features: stops.results.map((stop) => ({
          type: 'Feature' as const,
          properties: {
            stopUid: stop.stop_uid,
            stopName: stop.stop_name,
            sequence: stop.stop_sequence,
          },
          geometry: {
            type: 'Point' as const,
            coordinates: [stop.longitude, stop.latitude] as [number, number],
          },
        })),
      },
      updatedAt: pattern.updated_at,
    } satisfies RouteMapVariant
  }))).filter((variant): variant is RouteMapVariant => variant !== null)
}

export async function getSnapshotRouteCatalog(env: TransitBindings, city: string) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return []
  const result = await env.TRANSIT_DB.prepare(`
    SELECT route_uid, route_name, departure_name, destination_name
    FROM routes
    WHERE version = ? AND city_code = ?
    ORDER BY route_name
  `).bind(active.active_version, city).all<{
    route_uid: string
    route_name: string
    departure_name: string | null
    destination_name: string | null
  }>()
  return result.results.map((route) => ({
    routeUid: route.route_uid,
    routeName: route.route_name,
    departure: route.departure_name ?? undefined,
    destination: route.destination_name ?? undefined,
    category: classifyRouteName(route.route_name),
  }))
}

export async function getCityNetwork(env: TransitBindings, city: string) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return null

  const bundleKey = `snapshots/${active.active_version}/cities/${city}/network.json`
  const bundle = await env.TRANSIT_SHAPES.get(bundleKey)
  if (bundle) return await bundle.json<{
    version: string
    routes: Array<{
      routeName: string
      variantKey: string
      label: string
      shape: ShapeFeature
    }>
    places: Array<{
      placeId: string
      name: string
      latitude: number
      longitude: number
    }>
  }>()

  const [patterns, places] = await Promise.all([
    env.TRANSIT_DB.prepare(`
      SELECT p.pattern_id, p.route_uid, r.route_name, p.subroute_name, p.direction,
        p.departure_name, p.destination_name, p.shape_key, p.updated_at
      FROM patterns p
      JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
      WHERE p.version = ? AND p.city_code = ?
      ORDER BY r.route_name, p.direction, p.pattern_id
    `).bind(active.active_version, city).all<PatternRow>(),
    env.TRANSIT_DB.prepare(`
      SELECT place_id, place_name, latitude, longitude
      FROM stop_places
      WHERE version = ? AND city_code = ?
      ORDER BY place_name
    `).bind(active.active_version, city).all<{
      place_id: string
      place_name: string
      latitude: number
      longitude: number
    }>(),
  ])

  const routes = (await Promise.all(patterns.results.map(async (pattern) => {
    const object = await env.TRANSIT_SHAPES.get(pattern.shape_key)
    if (!object) return null
    return {
      routeName: pattern.route_name,
      variantKey: pattern.pattern_id,
      label: `${pattern.departure_name} → ${pattern.destination_name}`,
      shape: await object.json<ShapeFeature>(),
    }
  }))).filter((route): route is NonNullable<typeof route> => route !== null)

  return {
    version: active.active_version,
    routes,
    places: places.results.map((place) => ({
      placeId: place.place_id,
      name: place.place_name,
      latitude: place.latitude,
      longitude: place.longitude,
    })),
  }
}

export async function findNearbyStopPlaces(
  env: TransitBindings,
  city: string,
  latitude: number,
  longitude: number,
  radiusMeters: number,
) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return []

  const latitudeDelta = radiusMeters / 111_320
  const longitudeDelta = radiusMeters / (111_320 * Math.max(0.2, Math.cos(latitude * Math.PI / 180)))
  const candidates = await env.TRANSIT_DB.prepare(`
    SELECT place_id, place_name, latitude, longitude
    FROM stop_places
    WHERE version = ? AND city_code = ?
      AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
    LIMIT 100
  `).bind(
    active.active_version, city,
    latitude - latitudeDelta, latitude + latitudeDelta,
    longitude - longitudeDelta, longitude + longitudeDelta,
  ).all<{ place_id: string; place_name: string; latitude: number; longitude: number }>()

  return candidates.results
    .map((place) => ({
      placeId: place.place_id,
      name: place.place_name,
      latitude: place.latitude,
      longitude: place.longitude,
      distanceMeters: distanceMeters(latitude, longitude, place.latitude, place.longitude),
    }))
    .filter((place) => place.distanceMeters <= radiusMeters)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
}

export async function getStopPlace(env: TransitBindings, city: string, placeId: string) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return null
  const place = await env.TRANSIT_DB.prepare(`
    SELECT place_id, place_name, latitude, longitude
    FROM stop_places
    WHERE version = ? AND city_code = ? AND place_id = ?
  `).bind(active.active_version, city, placeId).first<{
    place_id: string
    place_name: string
    latitude: number
    longitude: number
  }>()
  return place ? {
    placeId: place.place_id,
    name: place.place_name,
    latitude: place.latitude,
    longitude: place.longitude,
    distanceMeters: 0,
  } : null
}

export async function getStopPlaceRoutes(env: TransitBindings, city: string, placeId: string) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active) return []
  const result = await env.TRANSIT_DB.prepare(`
    SELECT DISTINCT r.route_uid, r.route_name, p.pattern_id, p.direction,
      p.departure_name, p.destination_name, p.subroute_name,
      ps.stop_uid, ps.stop_sequence, s.stop_name
    FROM pattern_stops ps
    JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    JOIN stops s ON s.version = ps.version AND s.stop_uid = ps.stop_uid
    WHERE ps.version = ? AND p.city_code = ? AND ps.place_id = ?
    ORDER BY r.route_name, p.direction
  `).bind(active.active_version, city, placeId).all<{
    route_uid: string
    route_name: string
    pattern_id: string
    direction: 0 | 1
    departure_name: string
    destination_name: string
    subroute_name: string
    stop_uid: string
    stop_sequence: number
    stop_name: string
  }>()
  return result.results.map((row) => ({
    routeUid: row.route_uid,
    routeName: row.route_name,
    variantKey: row.pattern_id,
    direction: row.direction,
    label: `${row.departure_name} → ${row.destination_name}`,
    subRouteName: row.subroute_name,
    stopUid: row.stop_uid,
    stopSequence: row.stop_sequence,
    stopName: row.stop_name,
  }))
}

export async function getDirectRoutes(
  env: TransitBindings,
  city: string,
  fromPlaceId: string,
  toPlaceId: string,
) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active || fromPlaceId === toPlaceId) return []

  const result = await env.TRANSIT_DB.prepare(`
    SELECT DISTINCT r.route_name, p.pattern_id, p.direction, p.subroute_name,
      p.departure_name, p.destination_name,
      board.stop_sequence AS board_sequence,
      alight.stop_sequence AS alight_sequence
    FROM pattern_stops board
    JOIN pattern_stops alight
      ON alight.version = board.version
      AND alight.pattern_id = board.pattern_id
      AND alight.stop_sequence > board.stop_sequence
    JOIN patterns p
      ON p.version = board.version AND p.pattern_id = board.pattern_id
    JOIN routes r
      ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE board.version = ? AND p.city_code = ?
      AND board.place_id = ? AND alight.place_id = ?
    ORDER BY (alight.stop_sequence - board.stop_sequence), r.route_name
    LIMIT 24
  `).bind(active.active_version, city, fromPlaceId, toPlaceId).all<{
    route_name: string
    pattern_id: string
    direction: 0 | 1
    subroute_name: string
    departure_name: string
    destination_name: string
    board_sequence: number
    alight_sequence: number
  }>()

  return result.results.map((row) => ({
    routeName: row.route_name,
    variantKey: row.pattern_id,
    direction: row.direction,
    label: `${row.departure_name} → ${row.destination_name}`,
    subRouteName: row.subroute_name,
    boardSequence: row.board_sequence,
    alightSequence: row.alight_sequence,
    stopCount: row.alight_sequence - row.board_sequence,
  }))
}

export async function getOneTransferRoutes(
  env: TransitBindings,
  city: string,
  fromPlaceId: string,
  toPlaceId: string,
) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active || fromPlaceId === toPlaceId) return []

  const result = await env.TRANSIT_DB.prepare(`
    WITH first_legs AS (
      SELECT board.pattern_id, transfer.place_id AS transfer_place_id,
        board.stop_sequence AS board_sequence, transfer.stop_sequence AS transfer_sequence
      FROM pattern_stops board
      JOIN pattern_stops transfer
        ON transfer.version = board.version
        AND transfer.pattern_id = board.pattern_id
        AND transfer.stop_sequence > board.stop_sequence
      WHERE board.version = ? AND board.place_id = ?
    ),
    second_legs AS (
      SELECT transfer.pattern_id, transfer.place_id AS transfer_place_id,
        transfer.stop_sequence AS transfer_sequence, alight.stop_sequence AS alight_sequence
      FROM pattern_stops transfer
      JOIN pattern_stops alight
        ON alight.version = transfer.version
        AND alight.pattern_id = transfer.pattern_id
        AND alight.stop_sequence > transfer.stop_sequence
      WHERE transfer.version = ? AND alight.place_id = ?
    )
    SELECT DISTINCT
      first_legs.transfer_place_id,
      second_legs.transfer_place_id AS second_transfer_place_id,
      first_place.place_name AS transfer_name,
      second_place.place_name AS second_transfer_name,
      first_place.latitude AS first_transfer_latitude,
      first_place.longitude AS first_transfer_longitude,
      second_place.latitude AS second_transfer_latitude,
      second_place.longitude AS second_transfer_longitude,
      first_pattern.pattern_id AS first_pattern_id,
      first_route.route_name AS first_route_name,
      first_pattern.departure_name AS first_departure_name,
      first_pattern.destination_name AS first_destination_name,
      first_legs.board_sequence, first_legs.transfer_sequence AS first_alight_sequence,
      second_pattern.pattern_id AS second_pattern_id,
      second_route.route_name AS second_route_name,
      second_pattern.departure_name AS second_departure_name,
      second_pattern.destination_name AS second_destination_name,
      second_legs.transfer_sequence AS second_board_sequence, second_legs.alight_sequence,
      (first_legs.transfer_sequence - first_legs.board_sequence
       + second_legs.alight_sequence - second_legs.transfer_sequence) AS total_stops
    FROM first_legs
    JOIN stop_places first_place
      ON first_place.version = ? AND first_place.place_id = first_legs.transfer_place_id
    JOIN stop_places second_place
      ON second_place.version = first_place.version
      AND second_place.latitude BETWEEN first_place.latitude - 0.0032 AND first_place.latitude + 0.0032
      AND second_place.longitude BETWEEN first_place.longitude - 0.0036 AND first_place.longitude + 0.0036
    JOIN second_legs ON second_legs.transfer_place_id = second_place.place_id
    JOIN patterns first_pattern
      ON first_pattern.version = ? AND first_pattern.pattern_id = first_legs.pattern_id
    JOIN patterns second_pattern
      ON second_pattern.version = first_pattern.version AND second_pattern.pattern_id = second_legs.pattern_id
    JOIN routes first_route
      ON first_route.version = first_pattern.version AND first_route.route_uid = first_pattern.route_uid
    JOIN routes second_route
      ON second_route.version = second_pattern.version AND second_route.route_uid = second_pattern.route_uid
    WHERE first_pattern.city_code = ?
      AND first_pattern.route_uid <> second_pattern.route_uid
    ORDER BY total_stops, first_route.route_name, second_route.route_name
    LIMIT 200
  `).bind(
    active.active_version, fromPlaceId,
    active.active_version, toPlaceId,
    active.active_version,
    active.active_version, city,
  ).all<{
    transfer_place_id: string
    second_transfer_place_id: string
    transfer_name: string
    second_transfer_name: string
    first_transfer_latitude: number
    first_transfer_longitude: number
    second_transfer_latitude: number
    second_transfer_longitude: number
    first_pattern_id: string
    first_route_name: string
    first_departure_name: string
    first_destination_name: string
    board_sequence: number
    first_alight_sequence: number
    second_pattern_id: string
    second_route_name: string
    second_departure_name: string
    second_destination_name: string
    second_board_sequence: number
    alight_sequence: number
    total_stops: number
  }>()

  const plans = result.results.map((row) => ({
    transferPlaceId: row.transfer_place_id,
    secondTransferPlaceId: row.second_transfer_place_id,
    transferName: row.transfer_place_id === row.second_transfer_place_id
      ? row.transfer_name
      : `${row.transfer_name} ↔ ${row.second_transfer_name}`,
    transferWalkMeters: Math.round(distanceMeters(
      row.first_transfer_latitude,
      row.first_transfer_longitude,
      row.second_transfer_latitude,
      row.second_transfer_longitude,
    )),
    totalStops: row.total_stops,
    first: {
      routeName: row.first_route_name,
      variantKey: row.first_pattern_id,
      label: `${row.first_departure_name} → ${row.first_destination_name}`,
      boardSequence: row.board_sequence,
      alightSequence: row.first_alight_sequence,
      stopCount: row.first_alight_sequence - row.board_sequence,
    },
    second: {
      routeName: row.second_route_name,
      variantKey: row.second_pattern_id,
      label: `${row.second_departure_name} → ${row.second_destination_name}`,
      boardSequence: row.second_board_sequence,
      alightSequence: row.alight_sequence,
      stopCount: row.alight_sequence - row.second_board_sequence,
    },
  })).filter((plan) => plan.transferWalkMeters <= 350)

  return [...new Map(plans.map((plan) => [
    `${plan.first.routeName}:${plan.second.routeName}:${plan.transferPlaceId}:${plan.secondTransferPlaceId}`,
    plan,
  ])).values()]
    .sort((a, b) => (a.totalStops + a.transferWalkMeters / 100) - (b.totalStops + b.transferWalkMeters / 100))
    .slice(0, 5)
}

export async function getJourneyLegStopRefs(
  env: TransitBindings,
  city: string,
  legs: Array<{ key: string; patternId: string; sequence: number }>,
) {
  const active = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!active || !legs.length) return []

  const results = await env.TRANSIT_DB.batch(legs.map((leg) => env.TRANSIT_DB.prepare(`
    SELECT p.route_uid, p.direction, r.route_name, ps.stop_uid
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    JOIN pattern_stops ps ON ps.version = p.version AND ps.pattern_id = p.pattern_id
    WHERE p.version = ? AND p.city_code = ? AND p.pattern_id = ? AND ps.stop_sequence = ?
    LIMIT 1
  `).bind(active.active_version, city, leg.patternId, leg.sequence)))

  return results.flatMap((result, index) => {
    const row = result.results[0] as {
      route_uid: string
      direction: 0 | 1
      route_name: string
      stop_uid: string
    } | undefined
    return row ? [{
      key: legs[index].key,
      patternId: legs[index].patternId,
      routeUid: row.route_uid,
      direction: row.direction,
      routeName: row.route_name,
      stopUid: row.stop_uid,
    }] : []
  })
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const radius = 6_371_000
  const toRadians = (value: number) => value * Math.PI / 180
  const deltaLat = toRadians(lat2 - lat1)
  const deltaLon = toRadians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
