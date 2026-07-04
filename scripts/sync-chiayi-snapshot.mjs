import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

const CITY = process.argv[2] ?? 'Chiayi'
const DATABASE = 'mochi-transit'
const BUCKET = 'mochi-transit-shapes'
const outputRoot = join('.transit-snapshot', CITY)
const vars = await readVars('.dev.vars')
if (!vars.TDX_CLIENT_ID || !vars.TDX_CLIENT_SECRET) {
  throw new Error('Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in .dev.vars')
}
// R2 物件走 S3 相容 API 直接 PUT/DELETE:wrangler CLI 每個物件要 spawn 一個 process,
// 大城市數萬個物件會跑不完(GitHub Actions 單 job 上限 6 小時)。
const r2 = await createR2Client()
if (!r2) {
  console.warn('R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / CLOUDFLARE_ACCOUNT_ID 未設定,'
    + '改用 wrangler CLI 逐物件上傳(僅適合小城市,大城市會非常慢)。')
}

const tokenResponse = await fetch('https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: vars.TDX_CLIENT_ID,
    client_secret: vars.TDX_CLIENT_SECRET,
  }),
})
if (!tokenResponse.ok) throw new Error(`TDX token failed (${tokenResponse.status})`)
const token = (await tokenResponse.json()).access_token
const base = `https://tdx.transportdata.tw/api/basic/v2/Bus`
const get = async (resource) => {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const response = await fetch(`${base}/${resource}/City/${CITY}?$format=JSON`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    })
    if (response.ok) return response.json()
    if (response.status !== 429 || attempt === 4) {
      throw new Error(`TDX ${resource} failed (${response.status})`)
    }
    const retryAfter = Number(response.headers.get('Retry-After'))
    const delay = Number.isFinite(retryAfter) ? Math.min(30, retryAfter) * 1000 : 2 ** (attempt + 1) * 1000
    await new Promise((resolve) => setTimeout(resolve, delay))
  }
  throw new Error(`TDX ${resource} retry exhausted`)
}

const routeItems = await get('Route')
const stopOfRouteItems = await get('StopOfRoute')
const shapeItems = await get('Shape')
const scheduleItems = await get('Schedule')

// 內容沒變就跳過整次匯入:D1 免費方案每天只有 10 萬列寫入額度,
// 多數縣市的路線資料幾週才變一次,沒必要每次全量重匯。
const stateKey = `snapshots/state/${CITY}.json`
const contentHash = hashContent([routeItems, stopOfRouteItems, shapeItems, scheduleItems])
if (r2 && process.env.SNAPSHOT_FORCE !== '1') {
  const previousState = await s3GetJson(stateKey)
  if (previousState?.contentHash === contentHash) {
    console.log(JSON.stringify({ city: CITY, skipped: true, reason: 'unchanged', version: previousState.version }))
    process.exit(0)
  }
}

// 放在 hash 檢查之後:跳過未變更城市時不用花這次遠端 D1 查詢
const existingRows = queryExistingSnapshots()
const version = new Date().toISOString().replace(/[-:.]/g, '')
const shapeDir = join(outputRoot, 'shapes')
const scheduleDir = join(outputRoot, 'schedules')
const placeDir = join(outputRoot, 'places')
await rm(outputRoot, { recursive: true, force: true })
await mkdir(shapeDir, { recursive: true })
await mkdir(scheduleDir, { recursive: true })
await mkdir(placeDir, { recursive: true })

const routeByUid = new Map()
for (const item of routeItems) {
  if (!item.RouteUID || !item.RouteName?.Zh_tw) continue
  routeByUid.set(item.RouteUID, {
    uid: item.RouteUID,
    name: item.RouteName.Zh_tw,
    departure: item.DepartureStopNameZh ?? null,
    destination: item.DestinationStopNameZh ?? null,
  })
}

const shapesByIdentity = new Map()
for (const item of shapeItems) {
  if (!item.RouteUID || ![0, 1].includes(item.Direction) || !item.EncodedPolyline) continue
  const key = `${item.RouteUID}:${item.Direction}`
  const list = shapesByIdentity.get(key) ?? []
  list.push(item)
  shapesByIdentity.set(key, list)
}

const schedulesByRouteUid = new Map()
for (const item of scheduleItems) {
  if (!item.RouteUID || !routeByUid.has(item.RouteUID)) continue
  const list = schedulesByRouteUid.get(item.RouteUID) ?? []
  list.push(item)
  schedulesByRouteUid.set(item.RouteUID, list)
}
for (const route of routeByUid.values()) {
  await writeFile(join(scheduleDir, `${route.uid}.json`), JSON.stringify(schedulesByRouteUid.get(route.uid) ?? []))
}

const patterns = []
const stops = new Map()
const places = new Map()
const patternStops = []
const usedShapes = new Map()
// 站位合併用的網格索引:同名站牌只跟鄰近 3×3 格內的既有站位比距離,
// 避免每個 stop 線性掃全部 places 的 O(n²)(台北規模會是數億次距離計算)。
// 格邊長 0.002°(緯度 ~222m,台灣緯度的經度 ~201m)≥ 合併半徑 200m,鄰格掃描才涵蓋所有候選。
const PLACE_GRID_DEGREES = 0.002
const placeGrid = new Map()
const placeGridKey = (normalized, latCell, lonCell) => `${normalized}:${latCell}:${lonCell}`
function findExistingPlace(normalized, lat, lon) {
  const latCell = Math.floor(lat / PLACE_GRID_DEGREES)
  const lonCell = Math.floor(lon / PLACE_GRID_DEGREES)
  for (let dLat = -1; dLat <= 1; dLat += 1) {
    for (let dLon = -1; dLon <= 1; dLon += 1) {
      const bucket = placeGrid.get(placeGridKey(normalized, latCell + dLat, lonCell + dLon))
      const match = bucket?.find((place) => distanceMeters(lat, lon, place.lat, place.lon) <= 200)
      if (match) return match
    }
  }
  return undefined
}
function indexPlace(place) {
  const key = placeGridKey(place.normalized, Math.floor(place.lat / PLACE_GRID_DEGREES), Math.floor(place.lon / PLACE_GRID_DEGREES))
  const bucket = placeGrid.get(key)
  if (bucket) bucket.push(place)
  else placeGrid.set(key, [place])
}
for (const item of stopOfRouteItems) {
  if (!item.RouteUID || ![0, 1].includes(item.Direction) || !item.Stops?.length) continue
  const route = routeByUid.get(item.RouteUID)
  if (!route) continue
  const identity = `${item.RouteUID}:${item.Direction}`
  const shapeIndex = usedShapes.get(identity) ?? 0
  const shape = (shapesByIdentity.get(identity) ?? [])[shapeIndex] ?? (shapesByIdentity.get(identity) ?? [])[0]
  usedShapes.set(identity, shapeIndex + 1)
  if (!shape) continue
  const validStops = item.Stops.filter((stop) => stop.StopUID && stop.StopName?.Zh_tw
    && Number.isFinite(stop.StopPosition?.PositionLat) && Number.isFinite(stop.StopPosition?.PositionLon))
  if (!validStops.length) continue
  const patternId = `${item.SubRouteUID ?? item.RouteUID}:${item.Direction}:${shapeIndex}`
  const safeId = encodeURIComponent(patternId)
  const shapeKey = `snapshots/${version}/cities/${CITY}/shapes/${patternId}.json`
  const first = validStops[0].StopName.Zh_tw
  const last = validStops.at(-1).StopName.Zh_tw
  const shapeFeature = {
    type: 'Feature',
    properties: { routeUid: item.RouteUID, direction: item.Direction },
    geometry: { type: 'LineString', coordinates: decodePolyline(shape.EncodedPolyline) },
  }
  patterns.push({
    id: patternId, routeUid: item.RouteUID, subrouteUid: item.SubRouteUID ?? null,
    subrouteName: item.SubRouteName?.Zh_tw ?? route.name, direction: item.Direction,
    departure: first, destination: last, shapeKey, updatedAt: shape.UpdateTime ?? null, shapeFeature,
  })
  await writeFile(join(shapeDir, `${safeId}.json`), JSON.stringify(shapeFeature))

  for (const stop of validStops) {
    const lat = stop.StopPosition.PositionLat
    const lon = stop.StopPosition.PositionLon
    const normalized = normalizeName(stop.StopName.Zh_tw)
    const existingPlace = findExistingPlace(normalized, lat, lon)
    const placeId = existingPlace?.id ?? `${CITY}:${hash(`${normalized}:${lat.toFixed(4)}:${lon.toFixed(4)}`)}`
    stops.set(stop.StopUID, { uid: stop.StopUID, name: stop.StopName.Zh_tw, normalized, lat, lon, placeId })
    if (!existingPlace) {
      const place = { id: placeId, name: stop.StopName.Zh_tw, normalized, lat, lon }
      places.set(placeId, place)
      indexPlace(place)
    }
    patternStops.push({ patternId, stopUid: stop.StopUID, placeId, sequence: stop.StopSequence ?? 0 })
  }
}

const patternById = new Map(patterns.map((pattern) => [pattern.id, pattern]))
const placeBundles = new Map([...places.values()].map((place) => [place.id, {
  version,
  placeId: place.id,
  name: place.name,
  routes: [],
}]))
const seenPlaceRoutes = new Set()
for (const item of patternStops) {
  const pattern = patternById.get(item.patternId)
  const stop = stops.get(item.stopUid)
  const bundle = placeBundles.get(item.placeId)
  if (!pattern || !stop || !bundle) continue
  const identity = `${item.placeId}:${pattern.id}:${item.stopUid}`
  if (seenPlaceRoutes.has(identity)) continue
  seenPlaceRoutes.add(identity)
  const routeSchedules = schedulesByRouteUid.get(pattern.routeUid) ?? []
  const matchingSchedules = routeSchedules.filter((schedule) =>
    schedule.Direction === pattern.direction
    && (!pattern.subrouteUid || !schedule.SubRouteUID || schedule.SubRouteUID === pattern.subrouteUid))
  const schedules = matchingSchedules.map((schedule) => ({
    SubRouteUID: schedule.SubRouteUID,
    Direction: schedule.Direction,
    Timetables: (schedule.Timetables ?? []).map((timetable) => {
      const atThisStop = (timetable.StopTimes ?? []).filter((time) => time.StopUID === item.stopUid)
      // 有些縣市(如台南)每班次只提供起點發車時間,本站過濾後會全空;
      // 保留起點那筆,讓網頁端退回用「發車時間」估計,不然整站會變「暫無班次」。
      const stopTimes = atThisStop.length ? atThisStop : (timetable.StopTimes ?? [])
        .slice()
        .sort((a, b) => (a.StopSequence ?? 0) - (b.StopSequence ?? 0))
        .slice(0, 1)
      return { ServiceDay: timetable.ServiceDay, StopTimes: stopTimes }
    }).filter((timetable) => timetable.StopTimes.length),
  })).filter((schedule) => schedule.Timetables.length)
  bundle.routes.push({
    routeUid: pattern.routeUid,
    routeName: routeByUid.get(pattern.routeUid).name,
    variantKey: pattern.id,
    direction: pattern.direction,
    label: `${pattern.departure} → ${pattern.destination}`,
    subRouteUid: pattern.subrouteUid ?? undefined,
    subRouteName: pattern.subrouteName,
    stopUid: item.stopUid,
    stopSequence: item.sequence,
    stopName: stop.name,
    schedules,
  })
}
for (const bundle of placeBundles.values()) {
  await writeFile(join(placeDir, `${encodeURIComponent(bundle.placeId)}.json`), JSON.stringify(bundle))
}

const sql = []
sql.push('PRAGMA foreign_keys=OFF;')
for (const route of routeByUid.values()) sql.push(`INSERT INTO routes VALUES (${values(version, CITY, route.uid, route.name, route.departure, route.destination)});`)
for (const pattern of patterns) sql.push(`INSERT INTO patterns VALUES (${values(version, pattern.id, CITY, pattern.routeUid, pattern.subrouteUid, pattern.subrouteName, pattern.direction, pattern.departure, pattern.destination, pattern.shapeKey, pattern.updatedAt)});`)
for (const place of places.values()) sql.push(`INSERT INTO stop_places VALUES (${values(version, place.id, CITY, place.name, place.lat, place.lon)});`)
for (const stop of stops.values()) sql.push(`INSERT INTO stops VALUES (${values(version, stop.uid, CITY, stop.name, stop.normalized, stop.lat, stop.lon, stop.placeId)});`)
for (const item of patternStops) sql.push(`INSERT INTO pattern_stops VALUES (${values(version, item.patternId, item.stopUid, item.placeId, item.sequence)});`)
sql.push(`INSERT INTO dataset_versions(city_code, active_version, source_updated_at, imported_at) VALUES (${values(CITY, version, new Date().toISOString(), new Date().toISOString())}) ON CONFLICT(city_code) DO UPDATE SET active_version=excluded.active_version, source_updated_at=excluded.source_updated_at, imported_at=excluded.imported_at;`)
sql.push(`DELETE FROM pattern_stops WHERE version IN (SELECT DISTINCT version FROM patterns WHERE city_code=${sqlValue(CITY)}) AND version NOT IN (SELECT version FROM patterns WHERE city_code=${sqlValue(CITY)} GROUP BY version ORDER BY version DESC LIMIT 2);`)
sql.push(`DELETE FROM stops WHERE city_code=${sqlValue(CITY)} AND version NOT IN (SELECT version FROM stops WHERE city_code=${sqlValue(CITY)} GROUP BY version ORDER BY version DESC LIMIT 2);`)
sql.push(`DELETE FROM stop_places WHERE city_code=${sqlValue(CITY)} AND version NOT IN (SELECT version FROM stop_places WHERE city_code=${sqlValue(CITY)} GROUP BY version ORDER BY version DESC LIMIT 2);`)
sql.push(`DELETE FROM patterns WHERE city_code=${sqlValue(CITY)} AND version NOT IN (SELECT version FROM patterns WHERE city_code=${sqlValue(CITY)} GROUP BY version ORDER BY version DESC LIMIT 2);`)
sql.push(`DELETE FROM routes WHERE city_code=${sqlValue(CITY)} AND version NOT IN (SELECT version FROM routes WHERE city_code=${sqlValue(CITY)} GROUP BY version ORDER BY version DESC LIMIT 2);`)
// 大城市單檔數萬條 statement 會觸發 D1 大交易的內部錯誤(object reset),
// 分塊依序執行。安全性:啟用新版本的 dataset_versions upsert 在最後一塊,
// 中途失敗只會留下未啟用的孤兒列,線上仍由舊版本服務,重跑即可。
const SQL_CHUNK_STATEMENTS = 5000
const sqlFiles = []
for (let start = 0; start < sql.length; start += SQL_CHUNK_STATEMENTS) {
  const file = join(outputRoot, `import-${String(sqlFiles.length).padStart(2, '0')}.sql`)
  await writeFile(file, sql.slice(start, start + SQL_CHUNK_STATEMENTS).join('\n'))
  sqlFiles.push(file)
}

const networkKey = `snapshots/${version}/cities/${CITY}/network.json`
const networkFile = join(outputRoot, 'network.json')
await writeFile(networkFile, JSON.stringify({
  version,
  routes: patterns.map((pattern) => ({
    routeName: routeByUid.get(pattern.routeUid).name,
    variantKey: pattern.id,
    label: `${pattern.departure} → ${pattern.destination}`,
    shape: pattern.shapeFeature,
  })),
  places: [...places.values()].map((place) => ({
    placeId: place.id, name: place.name, latitude: place.lat, longitude: place.lon,
  })),
}))

await putObjects([
  ...patterns.map((pattern) => ({
    key: pattern.shapeKey,
    file: join(shapeDir, `${encodeURIComponent(pattern.id)}.json`),
    contentType: 'application/geo+json',
  })),
  ...[...routeByUid.values()].map((route) => ({
    key: `snapshots/${version}/cities/${CITY}/schedules/${route.uid}.json`,
    file: join(scheduleDir, `${route.uid}.json`),
    contentType: 'application/json',
  })),
  ...[...placeBundles.values()].map((bundle) => ({
    key: `snapshots/${version}/cities/${CITY}/places/${bundle.placeId}.json`,
    file: join(placeDir, `${encodeURIComponent(bundle.placeId)}.json`),
    contentType: 'application/json',
  })),
  { key: networkKey, file: networkFile, contentType: 'application/json' },
])
for (const file of sqlFiles) await runD1(file)
const previousVersion = [...new Set(existingRows.map((row) => row.version))].sort().at(-1)
const versionsToDelete = new Set(existingRows.map((row) => row.version).filter((item) => item !== previousVersion))
const staleRows = existingRows.filter((item) => versionsToDelete.has(item.version))
await deleteObjects([...new Set([
  ...staleRows.filter((item) => item.pattern_id)
    .map((item) => `snapshots/${item.version}/cities/${CITY}/shapes/${item.pattern_id}.json`),
  ...staleRows.filter((item) => item.route_uid)
    .map((item) => `snapshots/${item.version}/cities/${CITY}/schedules/${item.route_uid}.json`),
  ...staleRows.filter((item) => item.place_id)
    .map((item) => `snapshots/${item.version}/cities/${CITY}/places/${item.place_id}.json`),
  ...[...versionsToDelete].map((oldVersion) => `snapshots/${oldVersion}/cities/${CITY}/network.json`),
])])
if (r2) {
  await s3Request('PUT', stateKey, JSON.stringify({
    contentHash, version, updatedAt: new Date().toISOString(),
  }), 'application/json')
}
console.log(JSON.stringify({ city: CITY, version, routes: routeByUid.size, patterns: patterns.length, stops: stops.size, places: places.size, schedules: schedulesByRouteUid.size, placeBundles: placeBundles.size }))

function values(...items) { return items.map(sqlValue).join(', ') }
function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL'
  if (typeof value === 'number') return String(value)
  return `'${String(value).replaceAll("'", "''")}'`
}
function normalizeName(value) { return value.normalize('NFKC').replace(/[\s()（）]/g, '').toLowerCase() }
function hash(value) {
  let result = 2166136261
  for (const char of value) result = Math.imul(result ^ char.charCodeAt(0), 16777619)
  return (result >>> 0).toString(36)
}
function distanceMeters(lat1, lon1, lat2, lon2) {
  const radius = 6_371_000; const radians = (value) => value * Math.PI / 180
  const deltaLat = radians(lat2 - lat1); const deltaLon = radians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2 + Math.cos(radians(lat1)) * Math.cos(radians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * radius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
function decodePolyline(encoded) {
  const coordinates = []; let index = 0; let latitude = 0; let longitude = 0
  while (index < encoded.length) {
    const next = () => { let result = 0; let shift = 0; let byte; do { byte = encoded.charCodeAt(index++) - 63; result |= (byte & 31) << shift; shift += 5 } while (byte >= 32); return (result & 1) ? ~(result >> 1) : result >> 1 }
    latitude += next(); longitude += next(); coordinates.push([longitude / 1e5, latitude / 1e5])
  }
  return coordinates
}
async function readVars(file) {
  const content = await readFile(file, 'utf8')
  return Object.fromEntries(content.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('='); return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`${command} failed (${result.error?.message ?? result.status})`)
}
// D1 大匯入偶發 internal error 且官方明示可安全重試(失敗會 rollback)
async function runD1(file) {
  for (let attempt = 1; ; attempt += 1) {
    const result = spawnSync(process.execPath, [
      'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE, '--remote', '--file', file,
    ], { stdio: 'inherit' })
    if (result.status === 0) return
    if (attempt >= 3) throw new Error(`d1 execute ${file} failed (${result.error?.message ?? result.status})`)
    console.warn(`d1 execute ${file} 失敗,${attempt * 10} 秒後重試 (${attempt}/3)`)
    await new Promise((resolve) => setTimeout(resolve, attempt * 10_000))
  }
}
async function createR2Client() {
  const accessKeyId = vars.R2_ACCESS_KEY_ID ?? process.env.R2_ACCESS_KEY_ID
  const secretAccessKey = vars.R2_SECRET_ACCESS_KEY ?? process.env.R2_SECRET_ACCESS_KEY
  const accountId = vars.CLOUDFLARE_ACCOUNT_ID ?? process.env.CLOUDFLARE_ACCOUNT_ID
  if (!accessKeyId || !secretAccessKey || !accountId) return null
  const { AwsClient } = await import('aws4fetch')
  return {
    client: new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' }),
    baseUrl: `https://${accountId}.r2.cloudflarestorage.com/${BUCKET}`,
  }
}
function hashContent(payloads) {
  // 快照產出格式的版本:bundle/network 的結構有改就 +1,
  // 讓所有城市自動重匯,不會被「內容未變更」跳過而留著舊格式。
  const SNAPSHOT_FORMAT = 2
  // UpdateTime/VersionID 這類欄位在 TDX 重新發佈時會變動,但不影響我們匯入的內容,
  // 納入 hash 會讓「跳過未變更城市」幾乎永遠不生效。
  const volatileKeys = new Set(['UpdateTime', 'SrcUpdateTime', 'SrcTransTime', 'VersionID'])
  const stable = JSON.stringify(payloads, (key, value) => volatileKeys.has(key) ? undefined : value)
  return createHash('sha256').update(`format:${SNAPSHOT_FORMAT}\n`).update(stable).digest('hex')
}
async function s3GetJson(key) {
  const response = await r2.client.fetch(objectUrl(key))
  if (response.status === 404) {
    await response.arrayBuffer()
    return null
  }
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`R2 GET ${key} failed (${response.status})`)
  }
  return await response.json()
}
function objectUrl(key) {
  // key 內含 ':' 等字元,SigV4 的 canonical URI 要求 percent-encoding,
  // 逐段編碼讓簽章與 R2 端的正規化結果一致。
  return `${r2.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
}
async function s3Request(method, key, body, contentType) {
  for (let attempt = 1; ; attempt += 1) {
    const outcome = await r2.client.fetch(objectUrl(key), {
      method, body, headers: contentType ? { 'Content-Type': contentType } : undefined,
    }).then(async (response) => {
      await response.arrayBuffer()
      if (response.ok || (method === 'DELETE' && response.status === 404)) return {}
      return {
        error: new Error(`R2 ${method} ${key} failed (${response.status})`),
        retryable: response.status >= 500 || response.status === 429,
      }
    }).catch((error) => ({ error, retryable: true }))
    if (!outcome.error) return
    if (!outcome.retryable || attempt >= 4) throw outcome.error
    await new Promise((resolve) => setTimeout(resolve, 500 * attempt))
  }
}
async function putObjects(tasks) {
  if (r2) {
    await mapParallel(tasks, 32, async (task) =>
      s3Request('PUT', task.key, await readFile(task.file), task.contentType))
    return
  }
  await mapParallel(tasks, 6, (task) => spawnWrangler([
    'r2', 'object', 'put', `${BUCKET}/${task.key}`, '--remote', '--file', task.file, '--content-type', task.contentType,
  ]))
}
async function deleteObjects(keys) {
  if (r2) {
    await mapParallel(keys, 32, (key) => s3Request('DELETE', key))
    return
  }
  await mapParallel(keys, 6, (key) => spawnWrangler(['r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote']))
}
function spawnWrangler(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...args], { stdio: 'ignore' })
    child.on('error', reject)
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`wrangler ${args[0]} failed (${code})`)))
  })
}
async function mapParallel(items, concurrency, worker) {
  let index = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) await worker(items[index++])
  })
  await Promise.all(runners)
}
function queryExistingSnapshots() {
  // 從 routes 出發:沒有任何 pattern 的路線(缺 shape / StopOfRoute)也上傳過 schedule 物件,
  // 清理必須涵蓋它們,否則舊版 schedule 會永遠留在 R2。
  const sql = `SELECT DISTINCT r.version, r.route_uid, p.pattern_id, ps.place_id FROM routes r LEFT JOIN patterns p ON p.version=r.version AND p.route_uid=r.route_uid LEFT JOIN pattern_stops ps ON ps.version=p.version AND ps.pattern_id=p.pattern_id WHERE r.city_code='${CITY.replaceAll("'", "''")}'`
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE,
    '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to inspect existing snapshots: ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  return payload[0]?.results ?? []
}
