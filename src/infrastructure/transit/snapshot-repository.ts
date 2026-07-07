import type { RouteMapVariant } from '../../domain/map/map-model'
import { pairTransferLegs, type TransferLegCandidate } from '../../domain/map/transfer'
import { classifyRouteName } from '../../domain/route-category'
import type { ScheduleItem } from '../../domain/schedule'
import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'

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

// 每個查詢都要先知道 active_version,但它只在 sync 換版時才變;
// 記憶體快取 60 秒,省掉每個請求開頭那一次序列 D1 往返。
async function getActiveVersion(env: TransitBindings, city: string): Promise<string | null> {
  const memoryKey = `transit/active-version/${city}`
  const memoized = memoryCacheGet<string>(memoryKey)
  if (memoized) return memoized
  const row = await env.TRANSIT_DB.prepare(
    'SELECT active_version FROM dataset_versions WHERE city_code = ?',
  ).bind(city).first<ActiveVersion>()
  if (!row) return null
  memoryCacheSet(memoryKey, row.active_version, 60)
  return row.active_version
}

export async function getSnapshotSchedule(
  env: TransitBindings,
  city: string,
  routeName: string,
): Promise<ScheduleItem[] | null> {
  const version = await getActiveVersion(env, city)
  if (!version) return null
  const route = await env.TRANSIT_DB.prepare(`
    SELECT route_uid
    FROM routes
    WHERE version = ? AND city_code = ? AND route_name = ?
    LIMIT 1
  `).bind(version, city, routeName).first<{ route_uid: string }>()
  if (!route) return null
  const key = `snapshots/${version}/cities/${city}/schedules/${route.route_uid}.json`
  const object = await env.TRANSIT_SHAPES.get(key)
  return object ? await object.json<ScheduleItem[]>() : null
}

export type StopPlaceBundleRoute = {
  routeUid: string
  routeName: string
  variantKey: string
  direction: 0 | 1
  label: string
  subRouteUid?: string
  subRouteName: string
  stopUid: string
  stopSequence: number
  stopName: string
  schedules: ScheduleItem[]
}

export async function getStopPlaceBundle(env: TransitBindings, city: string, placeId: string) {
  const version = await getActiveVersion(env, city)
  if (!version) return null
  const key = `snapshots/${version}/cities/${city}/places/${placeId}.json`
  const object = await env.TRANSIT_SHAPES.get(key)
  return object ? await object.json<{
    version: string
    placeId: string
    name: string
    routes: StopPlaceBundleRoute[]
  }>() : null
}

export async function getSnapshotRouteVariants(
  env: TransitBindings,
  city: string,
  routeName: string,
): Promise<RouteMapVariant[]> {
  const version = await getActiveVersion(env, city)
  if (!version) return []

  const patterns = await env.TRANSIT_DB.prepare(`
    SELECT p.pattern_id, p.route_uid, r.route_name, p.subroute_name, p.direction,
           p.departure_name, p.destination_name, p.shape_key, p.updated_at
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE p.version = ? AND p.city_code = ? AND r.route_name = ?
    ORDER BY p.direction, p.pattern_id
  `).bind(version, city, routeName).all<PatternRow>()
  if (!patterns.results.length) return []

  return (await Promise.all(patterns.results.map(async (pattern) => {
    const [stops, shapeObject] = await Promise.all([
      env.TRANSIT_DB.prepare(`
        SELECT s.stop_uid, s.stop_name, ps.stop_sequence, s.latitude, s.longitude
        FROM pattern_stops ps
        JOIN stops s ON s.version = ps.version AND s.stop_uid = ps.stop_uid
        WHERE ps.version = ? AND ps.pattern_id = ?
        ORDER BY ps.stop_sequence
      `).bind(version, pattern.pattern_id).all<StopRow>(),
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
  const version = await getActiveVersion(env, city)
  if (!version) return []
  const result = await env.TRANSIT_DB.prepare(`
    SELECT route_uid, route_name, departure_name, destination_name
    FROM routes
    WHERE version = ? AND city_code = ?
    ORDER BY route_name
  `).bind(version, city).all<{
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
    category: classifyRouteName(route.route_name, route.route_uid),
  }))
}

export async function getCityNetwork(env: TransitBindings, city: string) {
  const version = await getActiveVersion(env, city)
  if (!version) return null

  const bundleKey = `snapshots/${version}/cities/${city}/network.json`
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
      LIMIT 41
    `).bind(version, city).all<PatternRow>(),
    env.TRANSIT_DB.prepare(`
      SELECT place_id, place_name, latitude, longitude
      FROM stop_places
      WHERE version = ? AND city_code = ?
      ORDER BY place_name
    `).bind(version, city).all<{
      place_id: string
      place_name: string
      latitude: number
      longitude: number
    }>(),
  ])

  // 這條 fallback 對每個 pattern 各發一次 R2 讀取,大城市會撞 Workers 的
  // subrequest 上限(免費方案每請求 50 次)。network.json 由 sync 保證產出,
  // fallback 只服務小城市;pattern 數超過上限就當作尚未建立全路網。
  if (patterns.results.length > 40) return null

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
    version: version,
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
  const version = await getActiveVersion(env, city)
  if (!version) return []

  const latitudeDelta = radiusMeters / 111_320
  const longitudeDelta = radiusMeters / (111_320 * Math.max(0.2, Math.cos(latitude * Math.PI / 180)))
  const candidates = await env.TRANSIT_DB.prepare(`
    SELECT place_id, place_name, latitude, longitude
    FROM stop_places
    WHERE version = ? AND city_code = ?
      AND latitude BETWEEN ? AND ? AND longitude BETWEEN ? AND ?
    LIMIT 100
  `).bind(
    version, city,
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

// 必須跟 scripts/sync-chiayi-snapshot.mjs 的 normalizeName 完全一致,
// 否則查詢字串對不上 stops.normalized_name 的內容。
function normalizeStopName(value: string): string {
  return value.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase()
    .replaceAll('臺', '台')
    .replace(/火車站|車站/g, '站')
    .replace(/站$/, '')
}

type SearchPlaceRow = {
  place_id: string
  place_name: string
  latitude: number
  longitude: number
}

export async function searchStopPlaces(
  env: TransitBindings,
  city: string,
  query: string,
  limit = 10,
) {
  const version = await getActiveVersion(env, city)
  if (!version) return []
  const normalized = normalizeStopName(query)
  if (!normalized) return []

  // 先做前綴比對:範圍條件走 stops_name_idx(version, city_code, normalized_name),
  // 不用 LIKE 是因為 ESCAPE 子句會關掉 SQLite 的 LIKE 索引最佳化。
  const prefix = await env.TRANSIT_DB.prepare(`
    SELECT s.place_id, p.place_name, p.latitude, p.longitude
    FROM stops s
    JOIN stop_places p ON p.version = s.version AND p.place_id = s.place_id
    WHERE s.version = ? AND s.city_code = ?
      AND s.normalized_name >= ? AND s.normalized_name < ?
    GROUP BY s.place_id
    ORDER BY p.place_name
    LIMIT ?
  `).bind(version, city, normalized, `${normalized}￿`, limit).all<SearchPlaceRow>()

  const seen = new Set(prefix.results.map((row) => row.place_id))
  let rows = prefix.results
  // 前綴不夠才補子字串(「北車」要找到「台北車站」):這一段掃該縣市的 stops,
  // 沒索引可用,但有 LIMIT 且回應有 edge 快取,量級可接受。
  if (rows.length < limit) {
    const escaped = normalized.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
    const substring = await env.TRANSIT_DB.prepare(`
      SELECT s.place_id, p.place_name, p.latitude, p.longitude
      FROM stops s
      JOIN stop_places p ON p.version = s.version AND p.place_id = s.place_id
      WHERE s.version = ? AND s.city_code = ?
        AND s.normalized_name LIKE ? ESCAPE '\\'
      GROUP BY s.place_id
      ORDER BY p.place_name
      LIMIT ?
    `).bind(version, city, `%${escaped}%`, limit).all<SearchPlaceRow>()
    rows = [...rows, ...substring.results.filter((row) => !seen.has(row.place_id))].slice(0, limit)
  }

  return rows.map((row) => ({
    placeId: row.place_id,
    name: row.place_name,
    latitude: row.latitude,
    longitude: row.longitude,
  }))
}

export async function getStopPlace(env: TransitBindings, city: string, placeId: string) {
  const version = await getActiveVersion(env, city)
  if (!version) return null
  const place = await env.TRANSIT_DB.prepare(`
    SELECT place_id, place_name, latitude, longitude
    FROM stop_places
    WHERE version = ? AND city_code = ? AND place_id = ?
  `).bind(version, city, placeId).first<{
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
  const version = await getActiveVersion(env, city)
  if (!version) return []
  const result = await env.TRANSIT_DB.prepare(`
    SELECT DISTINCT r.route_uid, r.route_name, p.pattern_id, p.direction,
      p.departure_name, p.destination_name, p.subroute_uid, p.subroute_name,
      ps.stop_uid, ps.stop_sequence, s.stop_name
    FROM pattern_stops ps
    JOIN patterns p ON p.version = ps.version AND p.pattern_id = ps.pattern_id
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    JOIN stops s ON s.version = ps.version AND s.stop_uid = ps.stop_uid
    WHERE ps.version = ? AND p.city_code = ? AND ps.place_id = ?
    ORDER BY r.route_name, p.direction
  `).bind(version, city, placeId).all<{
    route_uid: string
    route_name: string
    pattern_id: string
    direction: 0 | 1
    departure_name: string
    destination_name: string
    subroute_uid: string | null
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
    // 同一 routeUid 底下的支線可能共用同一個 stopUid+direction;
    // subRouteUid 是唯二能分辨「這是哪一條支線」的欄位(另一個是 pattern_id/variantKey)。
    subRouteUid: row.subroute_uid ?? undefined,
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
  const version = await getActiveVersion(env, city)
  if (!version || fromPlaceId === toPlaceId) return []

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
  `).bind(version, city, fromPlaceId, toPlaceId).all<{
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

type TransferLegRow = {
  pattern_id: string
  route_uid: string
  route_name: string
  departure_name: string
  destination_name: string
  board_sequence: number
  alight_sequence: number
  transfer_place_id: string
  place_name: string
  latitude: number
  longitude: number
}

export async function getOneTransferRoutes(
  env: TransitBindings,
  city: string,
  fromPlaceId: string,
  toPlaceId: string,
) {
  const version = await getActiveVersion(env, city)
  if (!version || fromPlaceId === toPlaceId) return []

  // SQL 只做便宜的兩端展開(各數百列、走索引),步行距離的空間接合交給
  // pairTransferLegs 在記憶體用網格做。舊版把接合塞在 SQL 的經緯度 box join,
  // 用不到索引,台南規模(2,500+ 站位)會直接撞 D1 的 CPU 上限。
  // anchor 先用 MATERIALIZED CTE 固定住(本站的十幾列,走 place 索引),
  // 再往 pattern_stops 的主鍵 join。不釘住的話查詢計畫器可能反過來
  // 先掃整個版本的 pattern_stops(單次 50 萬+列讀取)。
  const [forward, backward] = await env.TRANSIT_DB.batch([
    env.TRANSIT_DB.prepare(`
      WITH anchor AS MATERIALIZED (
        SELECT version, pattern_id, stop_sequence
        FROM pattern_stops
        WHERE version = ? AND place_id = ?
      )
      SELECT p.pattern_id, p.route_uid, r.route_name,
        p.departure_name, p.destination_name,
        anchor.stop_sequence AS board_sequence,
        transfer.stop_sequence AS alight_sequence,
        transfer.place_id AS transfer_place_id,
        place.place_name, place.latitude, place.longitude
      FROM anchor
      CROSS JOIN pattern_stops transfer
        ON transfer.version = anchor.version
        AND transfer.pattern_id = anchor.pattern_id
        AND transfer.stop_sequence > anchor.stop_sequence
      JOIN patterns p ON p.version = anchor.version AND p.pattern_id = anchor.pattern_id
      JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
      JOIN stop_places place ON place.version = anchor.version AND place.place_id = transfer.place_id
      WHERE p.city_code = ?
    `).bind(version, fromPlaceId, city),
    env.TRANSIT_DB.prepare(`
      WITH anchor AS MATERIALIZED (
        SELECT version, pattern_id, stop_sequence
        FROM pattern_stops
        WHERE version = ? AND place_id = ?
      )
      SELECT p.pattern_id, p.route_uid, r.route_name,
        p.departure_name, p.destination_name,
        transfer.stop_sequence AS board_sequence,
        anchor.stop_sequence AS alight_sequence,
        transfer.place_id AS transfer_place_id,
        place.place_name, place.latitude, place.longitude
      FROM anchor
      CROSS JOIN pattern_stops transfer
        ON transfer.version = anchor.version
        AND transfer.pattern_id = anchor.pattern_id
        AND transfer.stop_sequence < anchor.stop_sequence
      JOIN patterns p ON p.version = anchor.version AND p.pattern_id = anchor.pattern_id
      JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
      JOIN stop_places place ON place.version = anchor.version AND place.place_id = transfer.place_id
      WHERE p.city_code = ?
    `).bind(version, toPlaceId, city),
  ])

  const toCandidate = (row: TransferLegRow): TransferLegCandidate => ({
    patternId: row.pattern_id,
    routeUid: row.route_uid,
    routeName: row.route_name,
    label: `${row.departure_name} → ${row.destination_name}`,
    placeId: row.transfer_place_id,
    placeName: row.place_name,
    latitude: row.latitude,
    longitude: row.longitude,
    boardSequence: row.board_sequence,
    alightSequence: row.alight_sequence,
    stopCount: row.alight_sequence - row.board_sequence,
  })

  return pairTransferLegs(
    (forward.results as TransferLegRow[]).map(toCandidate),
    (backward.results as TransferLegRow[]).map(toCandidate),
  )
}

export async function getJourneyLegStopRefs(
  env: TransitBindings,
  city: string,
  legs: Array<{ key: string; patternId: string; sequence: number }>,
) {
  const version = await getActiveVersion(env, city)
  if (!version || !legs.length) return []

  const results = await env.TRANSIT_DB.batch(legs.map((leg) => env.TRANSIT_DB.prepare(`
    SELECT p.route_uid, p.direction, r.route_name, ps.stop_uid
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    JOIN pattern_stops ps ON ps.version = p.version AND ps.pattern_id = p.pattern_id
    WHERE p.version = ? AND p.city_code = ? AND p.pattern_id = ? AND ps.stop_sequence = ?
    LIMIT 1
  `).bind(version, city, leg.patternId, leg.sequence)))

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
