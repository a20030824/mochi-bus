import { readFileSync, writeFileSync } from 'node:fs'

function read(path) {
  return readFileSync(path, 'utf8')
}

function write(path, content) {
  writeFileSync(path, content)
}

function replaceOnce(path, before, after, label) {
  const source = read(path)
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`missing ${label} in ${path}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`multiple ${label} matches in ${path}`)
  }
  write(path, source.slice(0, first) + after + source.slice(first + before.length))
}

replaceOnce(
  'src/routes/bus.ts',
  "import { presentPageError, publicErrorMessage } from '../presentation/page-error'",
  "import { presentPageError } from '../presentation/page-error'",
  'page error import',
)

replaceOnce(
  'src/routes/bus.ts',
  `// 舊版 API 相容端點。
bus.get('/api/eta', async (c) => {
  try {
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, defaultBusQuery)
    return c.json(await getCommuteETA(env, resolved), 200, noStoreHeaders)
  } catch (error) {
    return jsonError(c, error)
  }
})

const shortcutHandler = async (c: Context<Env>) => {
  try {
    const query = hasBusQuery(c) ? parseRequestQuery(c) : defaultBusQuery
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, query)
    const result = await getCommuteETA(env, resolved)
    const staleText = result.stale ? '\\n⚠️ 資料可能延遲' : ''
    return c.text(\`${'${result.routeName}'}｜${'${result.stopName}'}\\n${'${result.label}'}${'${staleText}'}\`, 200, noStoreHeaders)
  } catch (error) {
    console.error('shortcut_eta_failed', error)
    return c.text(toPublicError(error), error instanceof QueryValidationError ? 400 : 503)
  }
}

bus.get('/shortcut', shortcutHandler)
bus.get('/bus/text', shortcutHandler)
bus.get('/text', shortcutHandler)

`,
  '',
  'retired endpoint block',
)

replaceOnce(
  'src/routes/bus.ts',
  `function toPublicError(error: unknown): string {
  return publicErrorMessage(error)
}

`,
  '',
  'shortcut public error helper',
)

replaceOnce(
  'README.md',
  '- `/shortcut?...`:iPhone 捷徑純文字輸出\n',
  '',
  'README shortcut page entry',
)

replaceOnce(
  'docs/OVERVIEW.md',
  '- PWA(可加到主畫面、離線提示頁)+ iPhone 捷徑純文字端點 `/shortcut`',
  '- PWA(可加到主畫面、離線提示頁)',
  'overview shortcut feature',
)

replaceOnce(
  'web/boards/store.ts',
  `// 舊名稱保留給尚未拆出的地圖 entry；語意已改成只操作首頁，不再增刪正式常用。
export function isFavoriteDirection(city: string, placeId: string, bus: FavoriteBus): boolean {
  return isHomeDirection(city, placeId, bus)
}

export function toggleFavoriteDirection(city: string, place: FavoritePlace, bus: FavoriteBus): boolean {
  return toggleHomeDirection(city, place, bus)
}

`,
  '',
  'favorite compatibility wrappers',
)

{
  const path = 'web/map/main.ts'
  const source = read(path)
  const isCount = source.match(/\bisFavoriteDirection\b/g)?.length ?? 0
  const toggleCount = source.match(/\btoggleFavoriteDirection\b/g)?.length ?? 0
  if (isCount < 2 || toggleCount < 2) {
    throw new Error(`unexpected favorite wrapper usage counts: ${isCount}/${toggleCount}`)
  }
  write(path, source
    .replaceAll('isFavoriteDirection', 'isHomeDirection')
    .replaceAll('toggleFavoriteDirection', 'toggleHomeDirection'))
}

replaceOnce(
  'package.json',
  '    "snapshot:chiayi": "node scripts/sync-transit-snapshot.mjs Chiayi",\n',
  '',
  'Chiayi-only package script',
)

if (!read('src/routes/retired-endpoints.test.ts').includes("'/api/eta'")) {
  throw new Error('retired endpoint regression test is missing')
}
