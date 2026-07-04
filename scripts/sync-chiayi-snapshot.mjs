import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'

const CITY = process.argv[2] ?? 'Chiayi'
const DATABASE = 'mochi-transit'
const BUCKET = 'mochi-transit-shapes'
const outputRoot = join('.transit-snapshot', CITY)
const existingRows = queryExistingSnapshots()
const vars = await readVars('.dev.vars')
if (!vars.TDX_CLIENT_ID || !vars.TDX_CLIENT_SECRET) {
  throw new Error('Missing TDX_CLIENT_ID or TDX_CLIENT_SECRET in .dev.vars')
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
    const existingPlace = [...places.values()].find((place) =>
      place.normalized === normalized && distanceMeters(lat, lon, place.lat, place.lon) <= 200,
    )
    const placeId = existingPlace?.id ?? `${CITY}:${hash(`${normalized}:${lat.toFixed(4)}:${lon.toFixed(4)}`)}`
    stops.set(stop.StopUID, { uid: stop.StopUID, name: stop.StopName.Zh_tw, normalized, lat, lon, placeId })
    if (!existingPlace) places.set(placeId, { id: placeId, name: stop.StopName.Zh_tw, normalized, lat, lon })
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
    Timetables: (schedule.Timetables ?? []).map((timetable) => ({
      ServiceDay: timetable.ServiceDay,
      StopTimes: (timetable.StopTimes ?? []).filter((time) => time.StopUID === item.stopUid),
    })).filter((timetable) => timetable.StopTimes.length),
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
const sqlFile = join(outputRoot, 'import.sql')
await writeFile(sqlFile, sql.join('\n'))

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

for (const pattern of patterns) {
  const local = join(shapeDir, `${encodeURIComponent(pattern.id)}.json`)
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'put', `${BUCKET}/${pattern.shapeKey}`, '--remote', '--file', local, '--content-type', 'application/geo+json'])
}
for (const route of routeByUid.values()) {
  const key = `snapshots/${version}/cities/${CITY}/schedules/${route.uid}.json`
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--remote', '--file', join(scheduleDir, `${route.uid}.json`), '--content-type', 'application/json'])
}
await runParallel([...placeBundles.values()].map((bundle) => ({
  command: process.execPath,
  args: [
    'node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'put',
    `${BUCKET}/snapshots/${version}/cities/${CITY}/places/${bundle.placeId}.json`,
    '--remote', '--file', join(placeDir, `${encodeURIComponent(bundle.placeId)}.json`),
    '--content-type', 'application/json',
  ],
})), 6)
run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'put', `${BUCKET}/${networkKey}`, '--remote', '--file', networkFile, '--content-type', 'application/json'])
run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE, '--remote', '--file', sqlFile])
const previousVersion = [...new Set(existingRows.map((row) => row.version))].sort().at(-1)
const versionsToDelete = new Set(existingRows.map((row) => row.version).filter((item) => item !== previousVersion))
const shapesToDelete = new Set(existingRows
  .filter((item) => versionsToDelete.has(item.version))
  .map((item) => `snapshots/${item.version}/cities/${CITY}/shapes/${item.pattern_id}.json`))
for (const key of shapesToDelete) {
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'])
}
const schedulesToDelete = new Set(existingRows
  .filter((item) => versionsToDelete.has(item.version) && item.route_uid)
  .map((item) => `snapshots/${item.version}/cities/${CITY}/schedules/${item.route_uid}.json`))
for (const key of schedulesToDelete) {
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'])
}
const placesToDelete = new Set(existingRows
  .filter((item) => versionsToDelete.has(item.version) && item.place_id)
  .map((item) => `snapshots/${item.version}/cities/${CITY}/places/${item.place_id}.json`))
await runParallel([...placesToDelete].map((key) => ({
  command: process.execPath,
  args: ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'],
})), 6)
for (const oldVersion of versionsToDelete) {
  const key = `snapshots/${oldVersion}/cities/${CITY}/network.json`
  run(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'r2', 'object', 'delete', `${BUCKET}/${key}`, '--remote'])
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
async function runParallel(tasks, concurrency) {
  let index = 0
  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (index < tasks.length) {
      const task = tasks[index++]
      await new Promise((resolve, reject) => {
        const child = spawn(task.command, task.args, { stdio: 'ignore' })
        child.on('error', reject)
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${task.command} failed (${code})`)))
      })
    }
  })
  await Promise.all(workers)
}
function queryExistingSnapshots() {
  const sql = `SELECT DISTINCT p.version, p.pattern_id, p.route_uid, ps.place_id FROM patterns p LEFT JOIN pattern_stops ps ON ps.version=p.version AND ps.pattern_id=p.pattern_id WHERE p.city_code='${CITY.replaceAll("'", "''")}'`
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', DATABASE,
    '--remote', '--json', '--command', sql,
  ], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Unable to inspect existing snapshots: ${result.stderr}`)
  const payload = JSON.parse(result.stdout)
  return payload[0]?.results ?? []
}
