import { isCircularShape } from '../../domain/map/journey-segment'
import type { RouteMapVariant } from '../../domain/map/map-model'
import type { LonLat } from '../../domain/map/network-pick'
import { simplifyLine } from '../../domain/map/simplify'
import { pairTransferLegs, type TransferLegCandidate } from '../../domain/map/transfer'
import { classifyRouteName } from '../../domain/route-category'
import type { ScheduleItem } from '../../domain/schedule'
import { memoryCacheGet, memoryCacheSet } from '../../lib/memory-cache'

// 跟 sync 腳本產出 network.json 使用同一個 8m 容差，確保預生成與 fallback
// 路徑的全路網 geometry 有一致的視覺精度。
// 這裡是小城市(<=40 patterns,沒有預生成 network.json)即時組裝的 fallback 路徑。
const NETWORK_LOD_TOLERANCE_METERS = 8

type ActiveVersion = { active_version: string }
type PatternRow = {
  pattern_id: string
  route_uid: string
  subroute_uid: string | null
  route_name: string
  subroute_name: string
  direction: 0 | 1 | 2
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

type ReachableLegRow = {
  shape_key: string
  board_sequence: number
  alight_sequence: number
  min_sequence: number
  max_sequence: number
}

type ReachableLeg<T extends ReachableLegRow> = T & { stop_count: number }

function journeyStopCount(row: ReachableLegRow): number {
  if (row.alight_sequence > row.board_sequence) return row.alight_sequence - row.board_sequence
  return row.max_sequence - row.board_sequence
    + row.alight_sequence - row.min_sequence + 1
}

async function isCircularPatternShape(env: TransitBindings, shapeKey: string): Promise<boolean> {
  const object = await env.TRANSIT_SHAPES.get(shapeKey)
  if (!object) return false
  try {
    const shape = await object.json<ShapeFeature>()
    return isCircularShape(shape.geometry.coordinates as Array<[number, number]>)
  } catch {
    return false
  }
}

async function reachableLegs<T extends ReachableLegRow>(
  env: TransitBindings,
  rows: T[],
  circularity = new Map<string, Promise<boolean>>(),
): Promise<Array<ReachableLeg<T>>> {
  const checked = await Promise.all(rows.map(async (row): Promise<ReachableLeg<T> | null> => {
    if (row.alight_sequence < row.board_sequence) {
      let check = circularity.get(row.shape_key)
      if (!check) {
        check = isCircularPatternShape(env, row.shape_key)
        circularity.set(row.shape_key, check)
      }
      if (!await check) return null
    }
    return { ...row, stop_count: journeyStopCount(row) }
  }))
  const reachable: Array<ReachableLeg<T>> = []
  for (const row of checked) {
    if (row) reachable.push(row)
  }
  return reachable
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

export function getActiveSnapshotVersion(env: TransitBindings, city: string): Promise<string | null> {
  return getActiveVersion(env, city)
}

export async function getSnapshotSchedule(
  env: TransitBindings,
  city: string,
  routeName: string,
  routeUid?: string,
): Promise<ScheduleItem[] | null> {
  const version = await getActiveVersion(env, city)
  if (!version) return null
  const route = routeUid
    ? await env.TRANSIT_DB.prepare(`
      SELECT route_uid
      FROM routes
      WHERE version = ? AND city_code = ? AND route_uid = ?
      LIMIT 1
    `).bind(version, city, routeUid).first<{ route_uid: string }>()
    : await env.TRANSIT_DB.prepare(`
      SELECT route_uid
      FROM routes
      WHERE version = ? AND city_code = ? AND route_name = ?
      ORDER BY route_uid
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
  direction: 0 | 1 | 2
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
    SELECT p.pattern_id, p.route_uid, p.subroute_uid, r.route_name, p.subroute_name, p.direction,
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
    const variant: RouteMapVariant = {
      variantKey: pattern.pattern_id,
      routeName: pattern.route_name,
      routeUid: pattern.route_uid,
      subRouteUid: pattern.subroute_uid ?? undefined,
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
    }
    return variant
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

export type CityNetworkResult =
  | { kind: 'stream'; body: ReadableStream; etag: string }
  | {
    kind: 'inline'
    network: {
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
    }
  }

export async function getCityNetwork(env: TransitBindings, city: string): Promise<CityNetworkResult | null> {
  const version = await getActiveVersion(env, city)
  if (!version) return null

  // 雙北的 network.json 有 35MB+:在 Worker 裡 json() 解析後記憶體膨脹好幾倍,
  // 再 stringify 一次就撞 isolate 的 128MB 上限,runtime 直接回 503。
  // R2 命中就把 body 原樣交給 handler 串流,Worker 不碰內容;
  // schemaVersion/city 這些回應欄位由 sync 腳本寫進檔案本身。
  const bundleKey = `snapshots/${version}/cities/${city}/network.json`
  const bundle = await env.TRANSIT_SHAPES.get(bundleKey)
  if (bundle) return { kind: 'stream', body: bundle.body, etag: bundle.httpEtag }

  const [patterns, places] = await Promise.all([
    env.TRANSIT_DB.prepare(`
      SELECT p.pattern_id, p.route_uid, p.subroute_uid, r.route_name, p.subroute_name, p.direction,
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
    const shape = await object.json<ShapeFeature>()
    return {
      routeName: pattern.route_name,
      variantKey: pattern.pattern_id,
      label: `${pattern.departure_name} → ${pattern.destination_name}`,
      shape: {
        ...shape,
        geometry: {
          ...shape.geometry,
          coordinates: simplifyLine(shape.geometry.coordinates as LonLat[], NETWORK_LOD_TOLERANCE_METERS),
        },
      },
    }
  }))).filter((route): route is NonNullable<typeof route> => route !== null)

  return {
    kind: 'inline',
    network: {
      version: version,
      routes,
      places: places.results.map((place) => ({
        placeId: place.place_id,
        name: place.place_name,
        latitude: place.latitude,
        longitude: place.longitude,
      })),
    },
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
    .sort((a, b) => a.distanceMeters - b.distanceMeters || a.placeId.localeCompare(b.placeId))
    .slice(0, 100)
}

// 必須跟 scripts/sync-transit-snapshot.mjs 的 normalizeName 完全一致,
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
    direction: 0 | 1 | 2
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
      p.departure_name, p.destination_name, p.shape_key,
      board.stop_sequence AS board_sequence,
      alight.stop_sequence AS alight_sequence,
      (SELECT MIN(path.stop_sequence)
        FROM pattern_stops path
        WHERE path.version = board.version AND path.pattern_id = board.pattern_id) AS min_sequence,
      (SELECT MAX(path.stop_sequence)
        FROM pattern_stops path
        WHERE path.version = board.version AND path.pattern_id = board.pattern_id) AS max_sequence
    FROM pattern_stops board
    JOIN pattern_stops alight
      ON alight.version = board.version
      AND alight.pattern_id = board.pattern_id
      AND alight.stop_sequence != board.stop_sequence
    JOIN patterns p
      ON p.version = board.version AND p.pattern_id = board.pattern_id
    JOIN routes r
      ON r.version = p.version AND r.route_uid = p.route_uid
    WHERE board.version = ? AND p.city_code = ?
      AND board.place_id = ? AND alight.place_id = ?
  `).bind(version, city, fromPlaceId, toPlaceId).all<DirectLegRow>()

  const best = new Map<string, ReachableLeg<DirectLegRow>>()
  for (const row of await reachableLegs(env, result.results)) {
    const existing = best.get(row.pattern_id)
    if (!existing || row.stop_count < existing.stop_count) best.set(row.pattern_id, row)
  }

  return [...best.values()]
    .sort((a, b) => a.stop_count - b.stop_count || a.route_name.localeCompare(b.route_name, 'zh-Hant', { numeric: true }))
    .slice(0, 24)
    .map((row) => ({
      routeName: row.route_name,
      variantKey: row.pattern_id,
      direction: row.direction,
      label: `${row.departure_name} → ${row.destination_name}`,
      subRouteName: row.subroute_name,
      boardSequence: row.board_sequence,
      alightSequence: row.alight_sequence,
      stopCount: row.stop_count,
    }))
}

type DirectLegRow = ReachableLegRow & {
  route_name: string
  pattern_id: string
  direction: 0 | 1 | 2
  subroute_name: string
  departure_name: string
  destination_name: string
}

type TransferLegRow = ReachableLegRow & {
  pattern_id: string
  route_uid: string
  route_name: string
  departure_name: string
  destination_name: string
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
  // pairTransferLegs 在記憶體用網格做。環狀 pattern 可能需要跨過站序首尾，
  // 因此先取同 pattern 的所有其他站；只有反向站序會再讀 R2 shape 驗證閉環。
  const [forward, backward] = await env.TRANSIT_DB.batch([
    env.TRANSIT_DB.prepare(`
      WITH anchor AS MATERIALIZED (
        SELECT version, pattern_id, stop_sequence
        FROM pattern_stops
        WHERE version = ? AND place_id = ?
      ),
      anchor_stats AS MATERIALIZED (
        SELECT anchor.version, anchor.pattern_id, anchor.stop_sequence,
          MIN(path.stop_sequence) AS min_sequence,
          MAX(path.stop_sequence) AS max_sequence
        FROM anchor
        JOIN pattern_stops path
          ON path.version = anchor.version AND path.pattern_id = anchor.pattern_id
        GROUP BY anchor.version, anchor.pattern_id, anchor.stop_sequence
      )
      SELECT p.pattern_id, p.route_uid, r.route_name,
        p.departure_name, p.destination_name, p.shape_key,
        anchor.stop_sequence AS board_sequence,
        transfer.stop_sequence AS alight_sequence,
        transfer.place_id AS transfer_place_id,
        place.place_name, place.latitude, place.longitude,
        anchor.min_sequence, anchor.max_sequence
      FROM anchor_stats anchor
      CROSS JOIN pattern_stops transfer
        ON transfer.version = anchor.version
        AND transfer.pattern_id = anchor.pattern_id
        AND transfer.stop_sequence != anchor.stop_sequence
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
      ),
      anchor_stats AS MATERIALIZED (
        SELECT anchor.version, anchor.pattern_id, anchor.stop_sequence,
          MIN(path.stop_sequence) AS min_sequence,
          MAX(path.stop_sequence) AS max_sequence
        FROM anchor
        JOIN pattern_stops path
          ON path.version = anchor.version AND path.pattern_id = anchor.pattern_id
        GROUP BY anchor.version, anchor.pattern_id, anchor.stop_sequence
      )
      SELECT p.pattern_id, p.route_uid, r.route_name,
        p.departure_name, p.destination_name, p.shape_key,
        transfer.stop_sequence AS board_sequence,
        anchor.stop_sequence AS alight_sequence,
        transfer.place_id AS transfer_place_id,
        place.place_name, place.latitude, place.longitude,
        anchor.min_sequence, anchor.max_sequence
      FROM anchor_stats anchor
      CROSS JOIN pattern_stops transfer
        ON transfer.version = anchor.version
        AND transfer.pattern_id = anchor.pattern_id
        AND transfer.stop_sequence != anchor.stop_sequence
      JOIN patterns p ON p.version = anchor.version AND p.pattern_id = anchor.pattern_id
      JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
      JOIN stop_places place ON place.version = anchor.version AND place.place_id = transfer.place_id
      WHERE p.city_code = ?
    `).bind(version, toPlaceId, city),
  ])

  const circularity = new Map<string, Promise<boolean>>()
  const [forwardRows, backwardRows] = await Promise.all([
    reachableLegs(env, forward.results as TransferLegRow[], circularity),
    reachableLegs(env, backward.results as TransferLegRow[], circularity),
  ])
  const toCandidate = (row: ReachableLeg<TransferLegRow>): TransferLegCandidate => ({
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
    stopCount: row.stop_count,
  })

  return pairTransferLegs(forwardRows.map(toCandidate), backwardRows.map(toCandidate))
}

export async function getJourneyLegStopRefs(
  env: TransitBindings,
  city: string,
  legs: Array<{ key: string; patternId: string; sequence: number }>,
) {
  const version = await getActiveVersion(env, city)
  if (!version || !legs.length) return []

  const results = await env.TRANSIT_DB.batch(legs.map((leg) => env.TRANSIT_DB.prepare(`
    SELECT p.route_uid, p.subroute_uid, p.direction, r.route_name, ps.stop_uid
    FROM patterns p
    JOIN routes r ON r.version = p.version AND r.route_uid = p.route_uid
    JOIN pattern_stops ps ON ps.version = p.version AND ps.pattern_id = p.pattern_id
    WHERE p.version = ? AND p.city_code = ? AND p.pattern_id = ? AND ps.stop_sequence = ?
    LIMIT 1
  `).bind(version, city, leg.patternId, leg.sequence)))

  return results.flatMap((result, index) => {
    const row = result.results[0] as {
      route_uid: string
      subroute_uid: string | null
      direction: 0 | 1 | 2
      route_name: string
      stop_uid: string
    } | undefined
    return row ? [{
      key: legs[index].key,
      patternId: legs[index].patternId,
      routeUid: row.route_uid,
      subRouteUid: row.subroute_uid ?? undefined,
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
// tdx-direction-diagnostic-base64: W3sic3RhZ2UiOiAiaW5wdXQtdGVzdHMiLCAiY29kZSI6IDAsICJvdXRwdXQiOiAiXG5cdTAwMWJbMW1cdTAwMWJbMzBtXHUwMDFiWzQ2bSBSVU4gXHUwMDFiWzQ5bVx1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszNm12NC4xLjkgXHUwMDFiWzM5bVx1MDAxYls5MG0vaG9tZS9ydW5uZXIvd29yay9tb2NoaS1idXMvbW9jaGktYnVzXHUwMDFiWzM5bVxuXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvZG9tYWluL2J1cy1xdWVyeS50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXBhcnNlQnVzUXVlcnlcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcmVqZWN0cyBKYXZhU2NyaXB0IG51bGwtbGlrZSBzdHJpbmdzIGFzIG1pc3Npbmcgc3RvcCB2YWx1ZXNcdTAwMWJbMzJtIDNcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvZG9tYWluL2J1cy1xdWVyeS50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXBhcnNlQnVzUXVlcnlcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcGFyc2VzIGEgaHVtYW4tcmVhZGFibGUgYnVzIHF1ZXJ5XHUwMDFiWzMybSAxXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2RvbWFpbi9idXMtcXVlcnkudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1wYXJzZUJ1c1F1ZXJ5XHUwMDFiWzJtID4gXHUwMDFiWzIybWFjY2VwdHMgU3RvcFVJRCB3aXRob3V0IGEgc3RvcCBuYW1lXHUwMDFiWzMybSAwXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2RvbWFpbi9idXMtcXVlcnkudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1wYXJzZUJ1c1F1ZXJ5XHUwMDFiWzJtID4gXHUwMDFiWzIybWFjY2VwdHMgdGhlIFREWCBjaXJjdWxhciBkaXJlY3Rpb25cdTAwMWJbMzJtIDBcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvZG9tYWluL2J1cy1xdWVyeS50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXBhcnNlQnVzUXVlcnlcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcmVqZWN0cyBhIGRpcmVjdGlvbiBvdXRzaWRlIHRoZSBURFggdmFsdWUgc2V0XHUwMDFiWzMybSAwXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2RvbWFpbi9idXMtcXVlcnkudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1wYXJzZUJ1c1F1ZXJ5XHUwMDFiWzJtID4gXHUwMDFiWzIybXJlamVjdHMgb3ZlcnNpemVkIHN0YWJsZSBpZGVudGlmaWVyc1x1MDAxYlszMm0gMVx1MDAxYlsybW1zXHUwMDFiWzIybVx1MDAxYlszOW1cbiBcdTAwMWJbMzJt4pyTXHUwMDFiWzM5bSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9kb21haW4vYnVzLXF1ZXJ5LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtY2Fub25pY2FsIFVSTHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJta2VlcHMgc3RhYmxlIElEcyBhbmQgaHVtYW4tcmVhZGFibGUgbmFtZXNcdTAwMWJbMzJtIDFcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzY3JpcHRzL3RyYW5zaXQtc25hcHNob3QvZGlyZWN0aW9uLnRlc3QubWpzXHUwMDFiWzJtID4gXHUwMDFiWzIybXNuYXBzaG90IGJ1cyBkaXJlY3Rpb25cdTAwMWJbMm0gPiBcdTAwMWJbMjJtYWNjZXB0cyBvdXRib3VuZCwgaW5ib3VuZCwgYW5kIGNpcmN1bGFyIFREWCBkaXJlY3Rpb25zXHUwMDFiWzMybSAyXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc2NyaXB0cy90cmFuc2l0LXNuYXBzaG90L2RpcmVjdGlvbi50ZXN0Lm1qc1x1MDAxYlsybSA+IFx1MDAxYlsyMm1zbmFwc2hvdCBidXMgZGlyZWN0aW9uXHUwMDFiWzJtID4gXHUwMDFiWzIybXJlamVjdHMgbWlzc2luZyBhbmQgdW5rbm93biBkaXJlY3Rpb24gdmFsdWVzXHUwMDFiWzMybSAwXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi9hcGktaW5wdXQudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1qb3VybmV5IEVUQSBpbnB1dFx1MDAxYlsybSA+IFx1MDAxYlsyMm1wYXJzZXMgYW5kIHRyaW1zIGEgdmFsaWQgcmVxdWVzdFx1MDAxYlszMm0gM1x1MDAxYlsybW1zXHUwMDFiWzIybVx1MDAxYlszOW1cbiBcdTAwMWJbMzJt4pyTXHUwMDFiWzM5bSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvYXBpLWlucHV0LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtam91cm5leSBFVEEgaW5wdXRcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcmVqZWN0cyBhIHBhcnRpYWxseSB2YWxpZCBsaXN0IGluc3RlYWQgb2Ygc2lsZW50bHkgZmlsdGVyaW5nIGl0XHUwMDFiWzMybSAwXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi9hcGktaW5wdXQudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1qb3VybmV5IEVUQSBpbnB1dFx1MDAxYlsybSA+IFx1MDAxYlsyMm1yZWplY3RzIGR1cGxpY2F0ZSBjbGllbnQga2V5cyBhbmQgdW5yZWFzb25hYmxlIHN0b3Agc2VxdWVuY2VzXHUwMDFiWzMybSAyXHUwMDFiWzJtbXNcdTAwMWJbMjJtXHUwMDFiWzM5bVxuIFx1MDAxYlszMm3inJNcdTAwMWJbMzltIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi9hcGktaW5wdXQudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1KU09OIHJlcXVlc3QgcGFyc2luZ1x1MDAxYlsybSA+IFx1MDAxYlsyMm1hY2NlcHRzIEpTT04gbWVkaWEgdHlwZXMgYW5kIHJlamVjdHMgdW5zdXBwb3J0ZWQgb3IgbWFsZm9ybWVkIGJvZGllc1x1MDAxYlszMm0gNDBcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL2FwaS1pbnB1dC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXF1ZXJ5IGFuZCBjcmVkZW50aWFsIGJvdW5kYXJpZXNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtdmFsaWRhdGVzIGNvb3JkaW5hdGUgYW5kIHJhZGl1cyByYW5nZXMgd2l0aG91dCBOYU4gY29lcmNpb25cdTAwMWJbMzJtIDFcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL2FwaS1pbnB1dC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXF1ZXJ5IGFuZCBjcmVkZW50aWFsIGJvdW5kYXJpZXNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtYWNjZXB0cyBvcHRpb25hbCBURFggZGlyZWN0aW9ucyAwLCAxLCBhbmQgMlx1MDAxYlszMm0gMFx1MDAxYlsybW1zXHUwMDFiWzIybVx1MDAxYlszOW1cbiBcdTAwMWJbMzJt4pyTXHUwMDFiWzM5bSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvYXBpLWlucHV0LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcXVlcnkgYW5kIGNyZWRlbnRpYWwgYm91bmRhcmllc1x1MDAxYlsybSA+IFx1MDAxYlsyMm1yZXF1aXJlcyBhIGNvbXBsZXRlLCBib3VuZGVkIFREWCBjcmVkZW50aWFsIHBhaXJcdTAwMWJbMzJtIDFcdTAwMWJbMm1tc1x1MDAxYlsyMm1cdTAwMWJbMzltXG5cblx1MDAxYlsybSBUZXN0IEZpbGVzIFx1MDAxYlsyMm0gXHUwMDFiWzFtXHUwMDFiWzMybTMgcGFzc2VkXHUwMDFiWzM5bVx1MDAxYlsyMm1cdTAwMWJbOTBtICgzKVx1MDAxYlszOW1cblx1MDAxYlsybSAgICAgIFRlc3RzIFx1MDAxYlsyMm0gXHUwMDFiWzFtXHUwMDFiWzMybTE2IHBhc3NlZFx1MDAxYlszOW1cdTAwMWJbMjJtXHUwMDFiWzkwbSAoMTYpXHUwMDFiWzM5bVxuXHUwMDFiWzJtICAgU3RhcnQgYXQgXHUwMDFiWzIybSAxNzoyMzoxMFxuXHUwMDFiWzJtICAgRHVyYXRpb24gXHUwMDFiWzIybSAyNjZtc1x1MDAxYlsybSAodHJhbnNmb3JtIDc1bXMsIHNldHVwIDBtcywgaW1wb3J0IDEzN21zLCB0ZXN0cyA2M21zLCBlbnZpcm9ubWVudCAwbXMpXHUwMDFiWzIybVxuXG4ifSwgeyJzdGFnZSI6ICJ0ZHgtY2lyY3VsYXItdGVzdCIsICJjb2RlIjogMCwgIm91dHB1dCI6ICJjcmVkZW50aWFsIGNhY2hlIHJlc2lsaWVuY2VcdTAwMWJbMm0gPiBcdTAwMWJbMjJtc2luZ2xlLWZsaWdodHMgY29uY3VycmVudCB0b2tlbiByZXF1ZXN0cyBmb3IgdGhlIGV4YWN0IHNhbWUgY3JlZGVudGlhbFxuIFx1MDAxYlsybVx1MDAxYls5MG3ihpNcdTAwMWJbMzltXHUwMDFiWzIybSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvdGR4LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtVERYIGNyZWRlbnRpYWwgY2FjaGUgcmVzaWxpZW5jZVx1MDAxYlsybSA+IFx1MDAxYlsyMm1rZWVwcyB0aGUgdG9rZW4gY2FjaGUgYXQgYSBoYXJkIExSVSBjYXBcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCBjcmVkZW50aWFsIGNhY2hlIHJlc2lsaWVuY2VcdTAwMWJbMm0gPiBcdTAwMWJbMjJtc2luZ2xlLWZsaWdodHMgY29uY3VycmVudCBkYXRhIG1pc3NlcyBmb3IgdGhlIHNhbWUgY3JlZGVudGlhbFxuIFx1MDAxYlsybVx1MDAxYls5MG3ihpNcdTAwMWJbMzltXHUwMDFiWzIybSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvdGR4LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtVERYIGNyZWRlbnRpYWwgY2FjaGUgcmVzaWxpZW5jZVx1MDAxYlsybSA+IFx1MDAxYlsyMm1yZXR1cm5zIFREWCBkYXRhIGJlZm9yZSBhIHNjaGVkdWxlZCBlZGdlLWNhY2hlIHdyaXRlIGZpbmlzaGVzXG4gXHUwMDFiWzJtXHUwMDFiWzkwbeKGk1x1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi90ZHgudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1URFggY3JlZGVudGlhbCBjYWNoZSByZXNpbGllbmNlXHUwMDFiWzJtID4gXHUwMDFiWzIybWRvZXMgbm90IHNoYXJlIGFuIGluLWZsaWdodCBkYXRhIGZhaWx1cmUgYWNyb3NzIGRpZmZlcmVudCBzZWNyZXRzXG4gXHUwMDFiWzJtXHUwMDFiWzkwbeKGk1x1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi90ZHgudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1URFggY3JlZGVudGlhbCBjYWNoZSByZXNpbGllbmNlXHUwMDFiWzJtID4gXHUwMDFiWzIybWFwcGxpZXMgdGhlIHNpeC1zZWNvbmQgdGltZW91dCBzaWduYWwgdG8gdG9rZW4gcmVxdWVzdHMgYW5kIHdyYXBzIGFib3J0c1xuIFx1MDAxYlsybVx1MDAxYls5MG3ihpNcdTAwMWJbMzltXHUwMDFiWzIybSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvdGR4LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtVERYIGNyZWRlbnRpYWwgY2FjaGUgcmVzaWxpZW5jZVx1MDAxYlsybSA+IFx1MDAxYlsyMm1vcGVucyB0aGUgY2lyY3VpdCBhZnRlciB0aHJlZSB0cmFuc2llbnQgZmFpbHVyZXNcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCBjcmVkZW50aWFsIGNhY2hlIHJlc2lsaWVuY2VcdTAwMWJbMm0gPiBcdTAwMWJbMjJta2VlcHMgZGF0YSBmYWlsdXJlcyBzZXBhcmF0ZSBmcm9tIGEgaGVhbHRoeSB0b2tlbiBlbmRwb2ludFxuIFx1MDAxYlsybVx1MDAxYls5MG3ihpNcdTAwMWJbMzltXHUwMDFiWzIybSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvdGR4LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtVERYIGNyZWRlbnRpYWwgY2FjaGUgcmVzaWxpZW5jZVx1MDAxYlsybSA+IFx1MDAxYlsyMm1vcGVucyBpbW1lZGlhdGVseSBvbiA0MjkgYW5kIGhvbm9ycyBSZXRyeS1BZnRlciBiZWZvcmUgYSBoYWxmLW9wZW4gcHJvYmVcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCB1cHN0cmVhbSBmYWlsdXJlc1x1MDAxYlsybSA+IFx1MDAxYlsyMm1tYXJrcyBFVEEgcmVzdWx0cyB3aGVuIHRoZSBzaGFyZWQgVERYIHBvb2wgaXMgcmF0ZSBsaW1pdGVkXG4gXHUwMDFiWzJtXHUwMDFiWzkwbeKGk1x1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi90ZHgudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1URFggdXBzdHJlYW0gZmFpbHVyZXNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtZXNjYWxhdGVzIHRvIGEgcXVvdGEgd2FybmluZyB3aGVuIDQyOSBwZXJzaXN0cyBwYXN0IHRoZSB0aHJlc2hvbGRcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCB1cHN0cmVhbSBmYWlsdXJlc1x1MDAxYlsybSA+IFx1MDAxYlsyMm1kb2VzIG5vdCBsZXQgYSBwZXJzb25hbCBjcmVkZW50aWFsIHRlc3Qgb24gdGhlIHNldHVwIHBhZ2UgY29udGFtaW5hdGUgdGhlIHNoYXJlZCBxdW90YSB0cmFja2VyXG4gXHUwMDFiWzJtXHUwMDFiWzkwbeKGk1x1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi90ZHgudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1URFggdXBzdHJlYW0gZmFpbHVyZXNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcmVjb2duaXplcyBxdW90YSByZXNwb25zZXMgZXZlbiB3aGVuIFREWCBkb2VzIG5vdCB1c2UgSFRUUCA0MjlcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCB1cHN0cmVhbSBmYWlsdXJlc1x1MDAxYlsybSA+IFx1MDAxYlsyMm1yZWNvZ25pemVzIHF1b3RhIHN1c3BlbnNpb24gd2hlbiBURFggcmVqZWN0cyB0aGUgdG9rZW4gcmVxdWVzdCBvdXRyaWdodFxuIFx1MDAxYlsybVx1MDAxYls5MG3ihpNcdTAwMWJbMzltXHUwMDFiWzIybSBcdTAwMWJbMzBtXHUwMDFiWzQzbSBub2RlIFx1MDAxYls0OW1cdTAwMWJbMzltIHNyYy9saWIvdGR4LnRlc3QudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtcm91dGUgdmFyaWFudHNcdTAwMWJbMm0gPiBcdTAwMWJbMjJtbWVyZ2VzIGR1cGxpY2F0ZSByb3dzIHdpdGggdGhlIHNhbWUgaWRlbnRpdHkgYW5kIGNvbXBsZXRlIHN0b3Agc2VxdWVuY2VcbiBcdTAwMWJbMm1cdTAwMWJbOTBt4oaTXHUwMDFiWzM5bVx1MDAxYlsyMm0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybXJvdXRlIHZhcmlhbnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybWtlZXBzIGRpZmZlcmVudCBTdWJSb3V0ZVVJRHMgZXZlbiB3aGVuIHRoZWlyIHN0b3Agc2VxdWVuY2VzIG1hdGNoXG4gXHUwMDFiWzJtXHUwMDFiWzkwbeKGk1x1MDAxYlszOW1cdTAwMWJbMjJtIFx1MDAxYlszMG1cdTAwMWJbNDNtIG5vZGUgXHUwMDFiWzQ5bVx1MDAxYlszOW0gc3JjL2xpYi90ZHgudGVzdC50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1yb3V0ZSB2YXJpYW50c1x1MDAxYlsybSA+IFx1MDAxYlsyMm1rZWVwcyB2YXJpYW50cyB0aGF0IHRha2UgZGlmZmVyZW50IHBhdGhzXG4gXHUwMDFiWzMybeKck1x1MDAxYlszOW0gXHUwMDFiWzMwbVx1MDAxYls0M20gbm9kZSBcdTAwMWJbNDltXHUwMDFiWzM5bSBzcmMvbGliL3RkeC50ZXN0LnRzXHUwMDFiWzJtID4gXHUwMDFiWzIybVREWCBjaXJjdWxhciByb3V0ZSBkaXJlY3Rpb25zXHUwMDFiWzJtID4gXHUwMDFiWzIybWtlZXBzIERpcmVjdGlvbiAyIHN0b3AgZ3JvdXBzIGluc3RlYWQgb2YgZHJvcHBpbmcgY2lyY3VsYXIgcm91dGVzXHUwMDFiWzMybSAzMFx1MDAxYlsybW1zXHUwMDFiWzIybVx1MDAxYlszOW1cblxuXHUwMDFiWzJtIFRlc3QgRmlsZXMgXHUwMDFiWzIybSBcdTAwMWJbMW1cdTAwMWJbMzJtMSBwYXNzZWRcdTAwMWJbMzltXHUwMDFiWzIybVx1MDAxYls5MG0gKDEpXHUwMDFiWzM5bVxuXHUwMDFiWzJtICAgICAgVGVzdHMgXHUwMDFiWzIybSBcdTAwMWJbMW1cdTAwMWJbMzJtMSBwYXNzZWRcdTAwMWJbMzltXHUwMDFiWzIybVx1MDAxYlsybSB8IFx1MDAxYlsyMm1cdTAwMWJbMzNtMjMgc2tpcHBlZFx1MDAxYlszOW1cdTAwMWJbOTBtICgyNClcdTAwMWJbMzltXG5cdTAwMWJbMm0gICBTdGFydCBhdCBcdTAwMWJbMjJtIDE3OjIzOjEyXG5cdTAwMWJbMm0gICBEdXJhdGlvbiBcdTAwMWJbMjJtIDMxMm1zXHUwMDFiWzJtICh0cmFuc2Zvcm0gMTIybXMsIHNldHVwIDBtcywgaW1wb3J0IDE1M21zLCB0ZXN0cyAzMW1zLCBlbnZpcm9ubWVudCAwbXMpXHUwMDFiWzIybVxuXG4ifSwgeyJzdGFnZSI6ICJ0eXBlY2hlY2siLCAiY29kZSI6IDAsICJvdXRwdXQiOiAiXG4+IHR5cGVjaGVja1xuPiB0c2MgLS1ub0VtaXRcblxuIn1d
