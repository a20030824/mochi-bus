import fs from 'node:fs'

function replaceOnce(source, before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`${label}: expected source block not found`)
  if (source.indexOf(before, first + before.length) >= 0) {
    throw new Error(`${label}: source block is not unique`)
  }
  return source.replace(before, after)
}

function update(path, transform) {
  const source = fs.readFileSync(path, 'utf8')
  const next = transform(source)
  if (next === source) throw new Error(`${path}: transformation produced no changes`)
  fs.writeFileSync(path, next)
}

update('src/domain/route-page-detail.ts', (source) => {
  source = replaceOnce(
    source,
    "  return { detail: routeDetailWithoutEta(query, group, '更新中') }",
    '  return { detail: buildRouteDetailWithoutEta(query, group) }',
    'static Route shell call',
  )
  source = replaceOnce(
    source,
    '      detail: routeDetailWithoutEta(query, group, unavailableLabel(warning)),',
    '      detail: buildRouteDetailWithoutEta(query, group, unavailableLabel(warning)),',
    'unavailable Route shell call',
  )
  return replaceOnce(
    source,
    `function routeDetailWithoutEta(
  query: ResolvedBusQuery,
  group: StopGroup,
  selectedStatus: string,
): RouteDetail {
  return {
    routeName: query.routeName,
    direction: query.direction,
    label: group.label,
    stops: group.stops.map((stop) => ({
      stopUid: stop.stopUid,
      stopName: stop.stopName,
      sequence: stop.sequence,
      selected: stop.stopUid === query.stopUid,
      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    })),
  }
}`,
    `export function buildRouteDetailWithoutEta(
  query: Pick<ResolvedBusQuery, 'routeName' | 'direction' | 'stopUid'>,
  group: {
    label: string
    stops: readonly Pick<RouteDetail['stops'][number], 'stopUid' | 'stopName' | 'sequence'>[]
  },
  selectedStatus = '更新中',
): RouteDetail {
  return {
    routeName: query.routeName,
    direction: query.direction,
    label: group.label,
    stops: group.stops.map((stop) => ({
      stopUid: stop.stopUid,
      stopName: stop.stopName,
      sequence: stop.sequence,
      selected: stop.stopUid === query.stopUid,
      etaLabel: stop.stopUid === query.stopUid ? selectedStatus : ROUTE_UNKNOWN_ETA_LABEL,
      etaTone: 'muted',
    })),
  }
}`,
    'shared ETA-free Route detail builder',
  )
})

update('src/routes/bus.ts', (source) => {
  source = replaceOnce(
    source,
    "import { getRoutePageDetail } from '../domain/route-page-detail'",
    "import { buildRouteDetailWithoutEta, getRoutePageDetail } from '../domain/route-page-detail'",
    'Route page detail import',
  )
  source = replaceOnce(
    source,
    `  const detail = {
    routeName: variant.routeName,
    direction: variant.direction,
    label: variant.label,
    stops: [...variant.stops.features]
      .sort((a, b) => a.properties.sequence - b.properties.sequence)
      .map((stop) => ({
        stopUid: stop.properties.stopUid,
        stopName: stop.properties.stopName,
        sequence: stop.properties.sequence,
        selected: stop.properties.stopUid === query.stopUid,
        etaLabel: stop.properties.stopUid === query.stopUid ? '僅站序' : null,
        etaTone: 'muted' as const,
      })),
  }`,
    '  const detail = buildSnapshotRouteDetail(variant, query.stopUid)',
    'snapshot detail construction',
  )
  return replaceOnce(
    source,
    `  return { resolved, detail }
}

bus.get('/api/v1/eta', async (c) => {`,
    `  return { resolved, detail }
}

type SnapshotRouteVariant = Awaited<ReturnType<typeof getSnapshotRouteVariants>>[number]

export function buildSnapshotRouteDetail(
  variant: SnapshotRouteVariant,
  selectedStopUid: string,
) {
  const stops = [...variant.stops.features]
    .sort((a, b) => a.properties.sequence - b.properties.sequence)
    .map((stop) => ({
      stopUid: stop.properties.stopUid,
      stopName: stop.properties.stopName,
      sequence: stop.properties.sequence,
    }))

  return buildRouteDetailWithoutEta({
    routeName: variant.routeName,
    direction: variant.direction,
    stopUid: selectedStopUid,
  }, {
    label: variant.label,
    stops,
  })
}

bus.get('/api/v1/eta', async (c) => {`,
    'snapshot Route detail helper',
  )
})

update('src/routes/bus.test.ts', (source) => {
  source = replaceOnce(
    source,
    "import { resolveTDXNotice } from './bus'",
    "import { buildSnapshotRouteDetail, resolveTDXNotice } from './bus'",
    'bus test import',
  )
  return source + `

describe('buildSnapshotRouteDetail', () => {
  it('uses the same ETA-free shell labels and ordering as the normal Route SSR path', () => {
    const variant = {
      routeName: '307',
      direction: 0,
      label: '板橋 → 撫遠街',
      stops: {
        features: [
          { properties: { stopUid: 'TPE2', stopName: '捷運西門站', sequence: 2 } },
          { properties: { stopUid: 'TPE1', stopName: '板橋公車站', sequence: 1 } },
          { properties: { stopUid: 'TPE3', stopName: '撫遠街', sequence: 3 } },
        ],
      },
    } as unknown as Parameters<typeof buildSnapshotRouteDetail>[0]

    const detail = buildSnapshotRouteDetail(variant, 'TPE2')

    expect(detail.stops.map((stop) => stop.stopUid)).toEqual(['TPE1', 'TPE2', 'TPE3'])
    expect(detail.stops.find((stop) => stop.selected)).toMatchObject({
      etaLabel: '更新中',
      etaTone: 'muted',
    })
    expect(detail.stops.filter((stop) => !stop.selected).every((stop) => stop.etaLabel === '—')).toBe(true)
    expect(detail.stops.some((stop) => stop.etaLabel === null || stop.etaLabel === '僅站序')).toBe(false)
  })
})
`
})
