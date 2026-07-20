import type {
  NearbyPlace,
  PlaceArrivalsResponse,
  PlaceRoute,
  RouteMapVariant,
} from './map-api-client'

const DEFAULT_PREVIEW_LIMIT = 8

export type PlaceRouteEntry = {
  route: PlaceRoute
  color: string
}

export type PlaceRoutesPresentation = {
  cityCode: string
  place: NearbyPlace
  routes: PlaceRouteEntry[]
  warning: PlaceArrivalsResponse['warning']
}

export type PlaceRoutePreview = PlaceRouteEntry & {
  variant: RouteMapVariant
}

export type PlaceRouteStart = {
  cityCode: string
  place: NearbyPlace
}

export type PlaceRouteFailure = PlaceRouteStart & {
  error: unknown
}

type PlaceRoutesControllerOptions = {
  currentCityCode: () => string | undefined
  beginRequest: () => { requestId: number; signal: AbortSignal }
  isStaleRequest: (requestId: number) => boolean
  loadRoutes: (
    cityCode: string,
    placeId: string,
    signal?: AbortSignal,
  ) => Promise<PlaceArrivalsResponse>
  loadVariant: (
    cityCode: string,
    routeName: string,
    variantKey: string,
  ) => Promise<RouteMapVariant | undefined>
  favoriteRouteUids: () => Iterable<string>
  routeColor: (routeName: string) => string
  clearPreview: () => void
  invalidateOtherPreviews: () => void
  onStart: (request: PlaceRouteStart) => void
  onRoutes: (presentation: PlaceRoutesPresentation) => void
  renderPreview: (preview: PlaceRoutePreview) => void
  onComplete: (presentation: PlaceRoutesPresentation) => void
  onError: (failure: PlaceRouteFailure) => void
  previewLimit?: number
}

export type PlaceRoutesController = {
  open(place: NearbyPlace): Promise<boolean>
  cancel(): void
}

export function createPlaceRoutesController(
  options: PlaceRoutesControllerOptions,
): PlaceRoutesController {
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT
  if (!Number.isInteger(previewLimit) || previewLimit <= 0) {
    throw new Error('Place route preview limit must be a positive integer')
  }

  let generation = 0

  function isCurrent(
    requestGeneration: number,
    cityCode: string,
    requestId: number,
  ): boolean {
    return generation === requestGeneration
      && options.currentCityCode() === cityCode
      && !options.isStaleRequest(requestId)
  }

  return {
    async open(place) {
      const cityCode = options.currentCityCode()
      if (!cityCode) return false

      generation += 1
      const requestGeneration = generation
      options.invalidateOtherPreviews()
      options.clearPreview()
      options.onStart({ cityCode, place })
      const { requestId, signal } = options.beginRequest()

      try {
        const arrivals = await options.loadRoutes(cityCode, place.placeId, signal)
        if (!isCurrent(requestGeneration, cityCode, requestId)) return false

        const routes = rankPlaceRoutes(arrivals.routes, options.favoriteRouteUids())
          .map((route): PlaceRouteEntry => ({
            route,
            color: options.routeColor(route.routeName),
          }))
        const presentation: PlaceRoutesPresentation = {
          cityCode,
          place,
          routes,
          warning: arrivals.warning,
        }
        options.onRoutes(presentation)

        const previews = await Promise.all(routes.slice(0, previewLimit).map(async (entry) => {
          const variant = await options.loadVariant(
            cityCode,
            entry.route.routeName,
            entry.route.variantKey,
          )
          return variant ? { ...entry, variant } : undefined
        }))
        if (!isCurrent(requestGeneration, cityCode, requestId)) return false

        for (const preview of previews) {
          if (preview) options.renderPreview(preview)
        }
        options.onComplete(presentation)
        return true
      } catch (error) {
        if (!isCurrent(requestGeneration, cityCode, requestId)) return false
        options.onError({ cityCode, place, error })
        return false
      }
    },

    cancel() {
      generation += 1
    },
  }
}

export function rankPlaceRoutes(
  routes: PlaceRoute[],
  favoriteRouteUids: Iterable<string>,
): PlaceRoute[] {
  const frequency = new Map<string, number>()
  for (const routeUid of favoriteRouteUids) {
    if (routeUid) frequency.set(routeUid, (frequency.get(routeUid) ?? 0) + 1)
  }
  return [...routes].sort((a, b) =>
    placeRouteRank(a, frequency) - placeRouteRank(b, frequency)
    || a.routeName.localeCompare(b.routeName, 'zh-Hant', { numeric: true }))
}

export function placeRouteRank(route: PlaceRoute, frequency: ReadonlyMap<string, number>): number {
  const eta = route.estimateSeconds === null ? 1_000_000 : route.estimateSeconds
  return eta - Math.min(frequency.get(route.routeUid) ?? 0, 5) * 15
}
