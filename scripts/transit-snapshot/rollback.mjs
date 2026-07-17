import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const city = process.argv[2]
if (!city) throw new Error('Usage: npm run snapshot:rollback -- <city> [version]')

const snapshotVars = await readVars('.snapshot.env')
const workerVars = await readVars('.dev.vars')
const vars = { ...workerVars, ...snapshotVars, ...process.env }
const accountId = vars.CLOUDFLARE_ACCOUNT_ID
const accessKeyId = vars.R2_ACCESS_KEY_ID
const secretAccessKey = vars.R2_SECRET_ACCESS_KEY
if (!accountId || !accessKeyId || !secretAccessKey) {
  throw new Error('Rollback requires CLOUDFLARE_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY')
}
if (!snapshotVars.R2_ACCESS_KEY_ID && workerVars.R2_ACCESS_KEY_ID) {
  console.warn('Snapshot publisher credentials in .dev.vars are deprecated; move them to .snapshot.env.')
}

const { AwsClient } = await import('aws4fetch')
const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' })
const baseUrl = `https://${accountId}.r2.cloudflarestorage.com/mochi-transit-shapes`
const stateKey = `snapshots/state/${city}.json`
const state = await getJson(stateKey)
if (!state?.version) throw new Error(`No published snapshot state found for ${city}`)
const targetVersion = process.argv[3] ?? state.previousVersion
if (!targetVersion) throw new Error(`No previous snapshot version recorded for ${city}`)
if (targetVersion === state.version) throw new Error(`${targetVersion} is already the recorded active version`)

const manifestExists = await objectExists(`snapshots/${targetVersion}/cities/${city}/manifest.json`)
if (!manifestExists && !await objectExists(`snapshots/${targetVersion}/cities/${city}/network.json`)) {
  throw new Error(`Target snapshot ${targetVersion} has no manifest or network object in R2`)
}
const targetManifest = manifestExists
  ? await getJson(`snapshots/${targetVersion}/cities/${city}/manifest.json`)
  : null
const rows = queryD1(`SELECT
  (SELECT COUNT(*) FROM routes WHERE city_code=${sql(city)} AND version=${sql(targetVersion)}) AS routes,
  (SELECT COUNT(*) FROM patterns WHERE city_code=${sql(city)} AND version=${sql(targetVersion)}) AS patterns,
  (SELECT COUNT(*) FROM stops WHERE city_code=${sql(city)} AND version=${sql(targetVersion)}) AS stops`)
const counts = rows[0]?.results?.[0]
if (!counts || Number(counts.routes) <= 0 || Number(counts.patterns) <= 0 || Number(counts.stops) <= 0) {
  throw new Error(`Target snapshot ${targetVersion} is incomplete in D1`)
}

const currentVersion = state.version
activate(targetVersion)
try {
  await smoke(targetVersion)
} catch (error) {
  activate(currentVersion)
  throw new Error(`Rollback smoke failed; restored ${currentVersion}: ${error instanceof Error ? error.message : String(error)}`)
}

await putJson(stateKey, {
  ...state,
  version: targetVersion,
  previousVersion: currentVersion,
  contentHash: targetManifest?.contentHash ?? null,
  counts: targetManifest?.counts ?? counts,
  quality: targetManifest?.quality ?? null,
  manifestKey: manifestExists ? `snapshots/${targetVersion}/cities/${city}/manifest.json` : null,
  publishedAt: new Date().toISOString(),
  rollback: { from: currentVersion, at: new Date().toISOString() },
})
console.log(JSON.stringify({ city, rolledBackFrom: currentVersion, activeVersion: targetVersion, counts }))

function activate(version) {
  const importedAt = new Date().toISOString()
  queryD1(`UPDATE dataset_versions SET active_version=${sql(version)}, imported_at=${sql(importedAt)} WHERE city_code=${sql(city)}`)
}
function queryD1(command) {
  const result = spawnSync(process.execPath, [
    'node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'mochi-transit',
    '--remote', '--json', '--command', command,
  ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`D1 command failed: ${result.stderr}`)
  return JSON.parse(result.stdout)
}
async function smoke(version) {
  const base = vars.SNAPSHOT_SMOKE_BASE_URL ?? 'https://bus.moc96336.com'
  let lastError
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const response = await fetch(`${base}/api/v1/map/routes?city=${encodeURIComponent(city)}&snapshot=${encodeURIComponent(version)}`, {
        cache: 'no-store', signal: AbortSignal.timeout(10_000),
      })
      const body = await response.json()
      if (!response.ok || body.source !== 'snapshot' || body.snapshotVersion !== version || !body.routes?.length) {
        throw new Error(`unexpected active snapshot ${body.snapshotVersion ?? 'missing'}`)
      }
      return
    } catch (error) {
      lastError = error
      if (attempt < 12) await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
  throw lastError
}
async function getJson(key) {
  const response = await client.fetch(objectUrl(key))
  if (!response.ok) {
    await response.arrayBuffer()
    throw new Error(`R2 GET ${key} failed (${response.status})`)
  }
  return response.json()
}
async function objectExists(key) {
  const response = await client.fetch(objectUrl(key), { method: 'HEAD' })
  await response.arrayBuffer()
  if (response.status === 404) return false
  if (!response.ok) throw new Error(`R2 HEAD ${key} failed (${response.status})`)
  return true
}
async function putJson(key, value) {
  const response = await client.fetch(objectUrl(key), {
    method: 'PUT', body: JSON.stringify(value), headers: { 'Content-Type': 'application/json' },
  })
  await response.arrayBuffer()
  if (!response.ok) throw new Error(`R2 PUT ${key} failed (${response.status})`)
}
function objectUrl(key) {
  return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`
}
function sql(value) {
  return `'${String(value).replaceAll("'", "''")}'`
}
async function readVars(file) {
  let content
  try { content = await readFile(file, 'utf8') }
  catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return {}
    throw error
  }
  return Object.fromEntries(content.split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
    const index = line.indexOf('=')
    return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')]
  }))
}
