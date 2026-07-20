import { selectDirectPreviewEntries } from '../../src/domain/map/direct-preview'
import type { DirectRoute, RouteMapVariant, TransferPlan } from './map-api-client'
import type { TripCoordinate, TripResultsState } from './trip-state'

const DEFAULT_DIRECT_PREVIEW_LIMIT = 8

export type JourneyPreviewLabels = readonly [string, string]

export type JourneyPreviewLeg = {
  variant: RouteMapVariant
  color: string
  boardSequence: number
  alightSequence: number
  labels: JourneyPreviewLabels
  selected: boolean
  onSelect: () => void
}

export type JourneyPreviewRenderResult = {
  focusCoordinates: TripCoordinate[]
  hasSegment: boolean
}

export type JourneyPreviewOptions = {
  fitCamera: boolean
}

type JourneyPreviewControllerOptions = {
  currentCityCode: () => string | undefined
  loadVariant: (
    cityCode: string,
    routeName: string,
    variantKey: string,
  ) => Promise<RouteMapVariant | undefined>
  clearPreview: () => void
  invalidateOtherPreviews: () => void
  routeColor: (routeName: string) => string
  transferLegColors: (firstRouteName: string, secondRouteName: string) => readonly [string, string]
  renderLeg: (leg: JourneyPreviewLeg) => JourneyPreviewRenderResult
  focusCoordinates: (coordinates: TripCoordinate[]) => void
  onSelectDirect: (index: number) => void
  onOpenRoute: (routeName: string, variantKey: string, color: string) => void
  directPreviewLimit?: number
}

export type JourneyPreviewController = {
  preview(state: TripResultsState, options: JourneyPreviewOptions): Promise<boolean>
  cancel(): void
}

type LoadedDirectPreview = {
  variant: RouteMapVariant
  route: DirectRoute
  color: string
  index: number
}

type LoadedTransferPreview = {
  variant: RouteMapVariant
  leg: TransferPlan['first']
  color: string
  labels: JourneyPreviewLabels
}

export function createJourneyPreviewController(
  options: JourneyPreviewControllerOptions,
): JourneyPreviewController {
  const directPreviewLimit = options.directPreviewLimit ?? DEFAULT_DIRECT_PREVIEW_LIMIT
  if (!Number.isInteger(directPreviewLimit) || directPreviewLimit <= 0) {
    throw new Error('Journey direct preview limit must be a positive integer')
  }

  let generation = 0

  function isCurrent(requestGeneration: number, cityCode: string): boolean {
    return generation === requestGeneration && options.currentCityCode() === cityCode
  }

  async function loadCurrent<T>(
    requestGeneration: number,
    cityCode: string,
    tasks: Array<Promise<T>>,
  ): Promise<T[] | undefined> {
    const settled = await Promise.allSettled(tasks)
    if (!isCurrent(requestGeneration, cityCode)) return undefined
    const values: T[] = []
    for (const result of settled) {
      if (result.status === 'rejected') throw result.reason
      values.push(result.value)
    }
    return values
  }

  function begin(cityCode: string): number {
    generation += 1
    options.invalidateOtherPreviews()
    options.clearPreview()
    return generation
  }

  async function previewDirect(
    state: Extract<TripResultsState, { resultKind: 'direct' }>,
    requestGeneration: number,
    cityCode: string,
    { fitCamera }: JourneyPreviewOptions,
  ): Promise<boolean> {
    const entries = selectDirectPreviewEntries(
      state.directRoutes,
      state.selectedDirectIndex,
      directPreviewLimit,
    )
    const loaded = await loadCurrent(
      requestGeneration,
      cityCode,
      entries.map(async ({ route, index }): Promise<LoadedDirectPreview | undefined> => {
        const variant = await options.loadVariant(cityCode, route.routeName, route.variantKey)
        return variant
          ? { variant, route, index, color: options.routeColor(route.routeName) }
          : undefined
      }),
    )
    if (!loaded) return false

    const focusCoordinates: TripCoordinate[] = []
    for (const preview of loaded) {
      if (!preview) continue
      const selected = preview.index === state.selectedDirectIndex
      const rendered = options.renderLeg({
        variant: preview.variant,
        color: preview.color,
        boardSequence: preview.route.boardSequence,
        alightSequence: preview.route.alightSequence,
        labels: ['上車', '下車'],
        selected,
        onSelect: () => options.onSelectDirect(preview.index),
      })
      if (selected && rendered.hasSegment) focusCoordinates.push(...rendered.focusCoordinates)
    }

    focusCoordinates.push(
      [state.from.place.latitude, state.from.place.longitude],
      [state.to.place.latitude, state.to.place.longitude],
    )
    if (fitCamera && focusCoordinates.length) options.focusCoordinates(focusCoordinates)
    return true
  }

  async function previewTransfer(
    state: Extract<TripResultsState, { resultKind: 'transfer' }>,
    requestGeneration: number,
    cityCode: string,
    { fitCamera }: JourneyPreviewOptions,
  ): Promise<boolean> {
    const plan = state.transferPlans[state.selectedTransferIndex]
    if (!plan) return false
    const colors = options.transferLegColors(plan.first.routeName, plan.second.routeName)
    const requests: Array<Promise<LoadedTransferPreview | undefined>> = [
      loadTransferLeg(plan.first, colors[0], ['上車', '轉乘']),
      loadTransferLeg(plan.second, colors[1], ['轉乘', '下車']),
    ]
    const loaded = await loadCurrent(requestGeneration, cityCode, requests)
    if (!loaded) return false

    const focusCoordinates: TripCoordinate[] = []
    for (const preview of loaded) {
      if (!preview) continue
      const rendered = options.renderLeg({
        variant: preview.variant,
        color: preview.color,
        boardSequence: preview.leg.boardSequence,
        alightSequence: preview.leg.alightSequence,
        labels: preview.labels,
        selected: true,
        onSelect: () => options.onOpenRoute(preview.leg.routeName, preview.leg.variantKey, preview.color),
      })
      focusCoordinates.push(...rendered.focusCoordinates)
    }
    if (state.from.coordinate) focusCoordinates.push(state.from.coordinate)
    if (state.to.coordinate) focusCoordinates.push(state.to.coordinate)
    if (fitCamera && focusCoordinates.length) options.focusCoordinates(focusCoordinates)
    return true

    async function loadTransferLeg(
      leg: TransferPlan['first'],
      color: string,
      labels: JourneyPreviewLabels,
    ): Promise<LoadedTransferPreview | undefined> {
      const variant = await options.loadVariant(cityCode, leg.routeName, leg.variantKey)
      return variant ? { variant, leg, color, labels } : undefined
    }
  }

  return {
    async preview(state, previewOptions) {
      const cityCode = options.currentCityCode()
      if (!cityCode) return false
      const requestGeneration = begin(cityCode)
      if (state.resultKind === 'empty') return false
      return state.resultKind === 'direct'
        ? previewDirect(state, requestGeneration, cityCode, previewOptions)
        : previewTransfer(state, requestGeneration, cityCode, previewOptions)
    },
    cancel() {
      generation += 1
    },
  }
}
