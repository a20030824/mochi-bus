export type MapView = 'overview' | 'region' | 'catalogue' | 'route' | 'nearby' | 'place' | 'trip-select' | 'trip-results'

const mapViews = new Set<MapView>([
  'overview',
  'region',
  'catalogue',
  'route',
  'nearby',
  'place',
  'trip-select',
  'trip-results',
])

export type MapHistoryCity = {
  code: string
  region: string
}

export type MapHistoryMutation = {
  mode: 'replace' | 'push'
  state: { mapView: MapView; mapParent?: MapView }
  url: string
}

export function historyRecord(state: unknown = history.state): Record<string, unknown> {
  return state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown>
    : {}
}

export function readMapView(state: unknown): MapView | undefined {
  if (!state || typeof state !== 'object' || Array.isArray(state)) return
  const view = (state as { mapView?: unknown }).mapView
  return typeof view === 'string' && mapViews.has(view as MapView) ? view as MapView : undefined
}

export function mapViewFromUrl(params = new URLSearchParams(location.search)): MapView {
  if (params.get('region')) return 'region'
  if (!params.get('city')) return 'overview'
  if (params.has('route')) return 'route'
  if (params.has('place') || params.has('stopUid')) return 'place'
  if (params.has('lat') && params.has('lon')) return 'nearby'
  if (params.get('trip') === 'results') return 'trip-results'
  if (params.get('trip') === 'select') return 'trip-select'
  return 'catalogue'
}

export function canonicalMapHistoryState(
  currentState: unknown,
  params: URLSearchParams,
): { view: MapView; state: Record<string, unknown>; changed: boolean } {
  const view = mapViewFromUrl(params)
  const current = historyRecord(currentState)
  const parent = parentForView(view, current.mapParent)
  const changed = readMapView(current) !== view || current.mapParent !== parent
  const next: Record<string, unknown> = { ...current, mapView: view }
  if (parent) next.mapParent = parent
  else delete next.mapParent
  return { view, state: next, changed }
}

export function planInitialMapHistory(options: {
  state: unknown
  params: URLSearchParams
  cities: readonly MapHistoryCity[]
  validRegions: ReadonlySet<string>
  originalUrl: string
}): MapHistoryMutation[] {
  if (readMapView(options.state)) return []

  const mutations: MapHistoryMutation[] = [
    { mode: 'replace', state: { mapView: 'overview' }, url: '/map' },
  ]
  const regionCode = options.params.get('region')
  if (regionCode && options.validRegions.has(regionCode)) {
    mutations.push({
      mode: 'push',
      state: { mapView: 'region', mapParent: 'overview' },
      url: options.originalUrl,
    })
    return mutations
  }

  const cityCode = options.params.get('city')
  if (!cityCode) return mutations
  const city = options.cities.find((candidate) => candidate.code === cityCode)
  if (!city) return mutations

  mutations.push(
    {
      mode: 'push',
      state: { mapView: 'region', mapParent: 'overview' },
      url: `/map?region=${city.region}`,
    },
    {
      mode: 'push',
      state: { mapView: 'catalogue', mapParent: 'region' },
      url: `/map?city=${encodeURIComponent(city.code)}`,
    },
  )

  const detailView = mapViewFromUrl(options.params)
  if (detailView !== 'catalogue') {
    mutations.push({
      mode: 'push',
      state: { mapView: detailView, mapParent: 'catalogue' },
      url: options.originalUrl,
    })
  }
  return mutations
}

function parentForView(view: MapView, currentParent: unknown): MapView | undefined {
  // The overview → region → catalogue spine is fixed. Detail views may preserve
  // a meaningful dynamic parent (for example route → trip results), but never a
  // root-level parent or a self-cycle that would make Back navigation ambiguous.
  if (view === 'overview') return undefined
  if (view === 'region') return 'overview'
  if (view === 'catalogue') return 'region'

  const parent = readMapView({ mapView: currentParent })
  if (!parent || parent === 'overview' || parent === 'region' || parent === view) return 'catalogue'
  return parent
}
