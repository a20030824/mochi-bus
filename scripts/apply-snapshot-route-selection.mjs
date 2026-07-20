import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is not unique`)
  }
  return source.replace(before, after)
}

const path = 'src/routes/bus.ts'
let source = fs.readFileSync(path, 'utf8')
source = replaceOnce(
  source,
  "import { buildRouteDetailWithoutEta, getRoutePageDetail } from '../domain/route-page-detail'\nimport { TDX_ACCESS_TOKEN_REJECTED_CODE, TDX_ACCESS_TOKEN_REJECTED_MESSAGE } from '../domain/tdx-api-error'",
  "import { buildRouteDetailWithoutEta, getRoutePageDetail } from '../domain/route-page-detail'\nimport { selectUniqueSnapshotRouteVariant } from '../domain/snapshot-route-selection'\nimport { TDX_ACCESS_TOKEN_REJECTED_CODE, TDX_ACCESS_TOKEN_REJECTED_MESSAGE } from '../domain/tdx-api-error'",
  'snapshot selection import',
)
source = replaceOnce(
  source,
  `  const variants = await getSnapshotRouteVariants(env, query.city, query.routeName)
  const matchingVariants = variants.filter((candidate) =>
    candidate.direction === query.direction
    && (!query.routeUid || candidate.routeUid === query.routeUid)
    && (!query.subRouteUid || candidate.subRouteUid === query.subRouteUid)
    && candidate.stops.features.some((stop) => stop.properties.stopUid === query.stopUid),
  )
  // 舊網址缺少支線身分時，只有唯一結果才能安全回退，禁止任意挑第一條。
  if (matchingVariants.length !== 1) return null
  const variant = matchingVariants[0]
  const selectedStop = variant.stops.features.find((stop) => stop.properties.stopUid === query.stopUid)!
`,
  `  const variants = await getSnapshotRouteVariants(env, query.city, query.routeName)
  const selection = selectUniqueSnapshotRouteVariant(variants, query)
  if (!selection) return null
  const { variant, selectedStop } = selection
`,
  'snapshot route selection',
)
fs.writeFileSync(path, source)
