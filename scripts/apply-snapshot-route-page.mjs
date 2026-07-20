import { readFile, writeFile } from 'node:fs/promises'

const path = 'src/routes/bus.ts'
let source = await readFile(path, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Missing ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`Duplicate ${label}`)
  }
  source = source.replace(before, after)
}

replaceOnce(
  "import { Hono, type Context } from 'hono'\nimport { defaultBusQuery, supportedCities, supportedCityCodes } from '../config'",
  "import { Hono, type Context } from 'hono'\nimport { getSnapshotRoutePage } from '../application/snapshot-route-page'\nimport { defaultBusQuery, supportedCities, supportedCityCodes } from '../config'",
  'application import anchor',
)

replaceOnce(
  "import { buildRouteDetailWithoutEta, getRoutePageDetail } from '../domain/route-page-detail'\nimport {\n  buildResolvedSnapshotRouteQuery,\n  selectUniqueSnapshotRouteVariant,\n} from '../domain/snapshot-route-selection'",
  "import { getRoutePageDetail } from '../domain/route-page-detail'",
  'old snapshot domain imports',
)

replaceOnce(
  "  getSnapshotRouteCatalog,\n  getSnapshotRouteVariants,\n  getStopPlaceByStopUid,",
  "  getSnapshotRouteCatalog,\n  getStopPlaceByStopUid,",
  'snapshot repository imports',
)

replaceOnce(
  `async function getSnapshotRoutePage(env: TDXEnv & TransitBindings, query: BusQuery) {\n  if (!query.stopUid) return null\n  const variants = await getSnapshotRouteVariants(env, query.city, query.routeName)\n  const selection = selectUniqueSnapshotRouteVariant(variants, query)\n  if (!selection) return null\n  const resolved = buildResolvedSnapshotRouteQuery(query, selection)\n  const detail = buildSnapshotRouteDetail(selection.variant, resolved.stopUid)\n  return { resolved, detail }\n}\n\ntype SnapshotRouteVariant = Awaited<ReturnType<typeof getSnapshotRouteVariants>>[number]\n\nexport function buildSnapshotRouteDetail(\n  variant: SnapshotRouteVariant,\n  selectedStopUid: string,\n) {\n  const stops = [...variant.stops.features]\n    .sort((a, b) => a.properties.sequence - b.properties.sequence)\n    .map((stop) => ({\n      stopUid: stop.properties.stopUid,\n      stopName: stop.properties.stopName,\n      sequence: stop.properties.sequence,\n    }))\n\n  return buildRouteDetailWithoutEta({\n    routeName: variant.routeName,\n    direction: variant.direction,\n    stopUid: selectedStopUid,\n  }, {\n    label: variant.label,\n    stops,\n  })\n}\n\n`,
  '',
  'inline snapshot route page orchestration',
)

for (const forbidden of [
  'buildRouteDetailWithoutEta',
  'buildResolvedSnapshotRouteQuery',
  'selectUniqueSnapshotRouteVariant',
  'getSnapshotRouteVariants',
  'function buildSnapshotRouteDetail',
]) {
  if (source.includes(forbidden)) throw new Error(`Stale bus.ts dependency: ${forbidden}`)
}

await writeFile(path, source)
