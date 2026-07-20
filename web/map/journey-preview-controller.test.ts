import { describe, expect, it, vi } from 'vitest'
import type { DirectRoute, NearbyPlace, RouteMapVariant, TransferPlan } from './map-api-client'
import {
  createJourneyPreviewController,
  type JourneyPreviewLeg,
  type JourneyPreviewRenderResult,
} from './journey-preview-controller'
import { createTripResultsState, type TripCoordinate, type TripResultsState } from './trip-state'

function place(id: string, latitude = 25, longitude = 121): NearbyPlace {
  return { placeId: id, name: id, latitude, longitude, distanceMeters: 0 }
}

function directRoute(name: string, boardSequence = 1, alightSequence = 4): DirectRoute {
  return {
    routeUid: `TPE-${name}`,
    routeName: name,
    variantKey: `${name}:0`,
    direction: 0,
    label: `往 ${name} 終點`,
    subRouteName: name,
    stopUid: `${name}-stop`,
    stopName: `${name} 站`,
    stopSequence: boardSequence,
    estimateSeconds: null,
    etaLabel: '未發車',
    stopStatus: 0,
    boardSequence,
    alightSequence,
    stopCount: alightSequence - boardSequence,
  }
}

function transferPlan(first = '307', second = '605'): TransferPlan {
  return {
    transferPlaceId: 'transfer',
    transferName: '轉乘站',
    totalStops: 7,
    first: {
      routeName: first,
      variantKey: `${first}:0`,
      label: '第一段',
      boardSequence: 1,
      alightSequence: 4,
      stopCount: 3,
    },
    second: {
      routeName: second,
      variantKey: `${second}:0`,
      label: '第二段',
      boardSequence: 2,
      alightSequence: 6,
      stopCount: 4,
    },
  }
}

function variant(routeName: string): RouteMapVariant {
  return {
    variantKey: `${routeName}:0`,
    routeName,
    routeUid: `TPE-${routeName}`,
    direction: 0,
    label: `往 ${routeName} 終點`,
    subRouteName: routeName,
    shape: {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: [[121, 25], [121.1, 25.1]] },
    },
    stops: { type: 'FeatureCollection', features: [] },
    updatedAt: null,
  }
}

function directState(routes: DirectRoute[], selectedDirectIndex = 0): TripResultsState {
  return createTripResultsState({
    from: { place: place('FROM', 25.01, 121.01), coordinate: [25, 121] },
    to: { place: place('TO', 25.21, 121.21), coordinate: [25.2, 121.2] },
    directRoutes: routes,
    transferPlans: [],
    selectedDirectIndex,
  })
}

function transferState(plans: TransferPlan[], selectedTransferIndex = 0): TripResultsState {
  return createTripResultsState({
    from: { place: place('FROM'), coordinate: [25, 121] },
    to: { place: place('TO'), coordinate: [25.2, 121.2] },
    directRoutes: [],
    transferPlans: plans,
    selectedTransferIndex,
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function createHarness(options: {
  loadVariant?: (cityCode: string, routeName: string, variantKey: string) => Promise<RouteMapVariant | undefined>
  renderLeg?: (leg: JourneyPreviewLeg) => JourneyPreviewRenderResult
  directPreviewLimit?: number
} = {}) {
  let cityCode: string | undefined = 'Taipei'
  const rendered: JourneyPreviewLeg[] = []
  const focused: TripCoordinate[][] = []
  const selectedDirect: number[] = []
  const openedRoutes: Array<[string, string, string]> = []
  let clearCount = 0
  let invalidatedOtherPreviews = 0
  const loadVariant = vi.fn(options.loadVariant ?? (async (_city, routeName) => variant(routeName)))
  const renderLeg = vi.fn((leg: JourneyPreviewLeg): JourneyPreviewRenderResult => {
    rendered.push(leg)
    return options.renderLeg?.(leg) ?? {
      focusCoordinates: [[leg.boardSequence, leg.alightSequence] as TripCoordinate],
      hasSegment: true,
    }
  })
  const controller = createJourneyPreviewController({
    currentCityCode: () => cityCode,
    loadVariant,
    clearPreview: () => { clearCount += 1 },
    invalidateOtherPreviews: () => { invalidatedOtherPreviews += 1 },
    routeColor: (routeName) => `color:${routeName}`,
    transferLegColors: (first, second) => [`first:${first}`, `second:${second}`],
    renderLeg,
    focusCoordinates: (coordinates) => focused.push(coordinates),
    onSelectDirect: (index) => selectedDirect.push(index),
    onOpenRoute: (routeName, variantKey, color) => openedRoutes.push([routeName, variantKey, color]),
    directPreviewLimit: options.directPreviewLimit,
  })
  return {
    controller,
    loadVariant,
    renderLeg,
    rendered,
    focused,
    selectedDirect,
    openedRoutes,
    clearCount: () => clearCount,
    invalidatedOtherPreviews: () => invalidatedOtherPreviews,
    setCityCode(value: string | undefined) { cityCode = value },
  }
}

describe('Journey preview controller', () => {
  it('loads bounded direct previews, marks the selected route, and focuses its segment plus endpoints', async () => {
    const routes = Array.from({ length: 10 }, (_, index) => directRoute(`R${index}`))
    const harness = createHarness()

    const completed = await harness.controller.preview(directState(routes, 9), { fitCamera: true })

    expect(completed).toBe(true)
    expect(harness.loadVariant).toHaveBeenCalledTimes(8)
    expect(harness.loadVariant.mock.calls.map((call) => call[1])).toEqual([
      'R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R9',
    ])
    expect(harness.rendered.map((entry) => [entry.variant.routeName, entry.selected])).toEqual([
      ['R0', false], ['R1', false], ['R2', false], ['R3', false],
      ['R4', false], ['R5', false], ['R6', false], ['R9', true],
    ])
    expect(harness.focused).toEqual([[
      [1, 4],
      [25.01, 121.01],
      [25.21, 121.21],
    ]])
    harness.rendered.at(-1)?.onSelect()
    expect(harness.selectedDirect).toEqual([9])
    expect(harness.clearCount()).toBe(1)
    expect(harness.invalidatedOtherPreviews()).toBe(1)
  })

  it('does not use a selected direct route without a rendered segment as camera focus', async () => {
    const harness = createHarness({
      renderLeg: (leg) => ({ focusCoordinates: [[leg.boardSequence, leg.alightSequence]], hasSegment: false }),
    })

    await harness.controller.preview(directState([directRoute('307')]), { fitCamera: true })

    expect(harness.focused).toEqual([[ [25.01, 121.01], [25.21, 121.21] ]])
  })

  it('loads both transfer legs, preserves labels and colors, and focuses legs plus chosen endpoints', async () => {
    const harness = createHarness()

    const completed = await harness.controller.preview(transferState([transferPlan()]), { fitCamera: true })

    expect(completed).toBe(true)
    expect(harness.rendered.map((entry) => ({
      route: entry.variant.routeName,
      color: entry.color,
      labels: entry.labels,
      selected: entry.selected,
    }))).toEqual([
      { route: '307', color: 'first:307', labels: ['上車', '轉乘'], selected: true },
      { route: '605', color: 'second:605', labels: ['轉乘', '下車'], selected: true },
    ])
    expect(harness.focused).toEqual([[
      [1, 4],
      [2, 6],
      [25, 121],
      [25.2, 121.2],
    ]])
    harness.rendered[0].onSelect()
    harness.rendered[1].onSelect()
    expect(harness.openedRoutes).toEqual([
      ['307', '307:0', 'first:307'],
      ['605', '605:0', 'second:605'],
    ])
  })

  it('clears an empty result without loading or focusing', async () => {
    const harness = createHarness()
    const state = createTripResultsState({
      from: { place: place('FROM') },
      to: { place: place('TO') },
      directRoutes: [],
      transferPlans: [],
    })

    await expect(harness.controller.preview(state, { fitCamera: true })).resolves.toBe(false)
    expect(harness.loadVariant).not.toHaveBeenCalled()
    expect(harness.renderLeg).not.toHaveBeenCalled()
    expect(harness.focused).toEqual([])
    expect(harness.clearCount()).toBe(1)
  })

  it('does not focus when camera fitting is disabled', async () => {
    const harness = createHarness()

    await harness.controller.preview(directState([directRoute('307')]), { fitCamera: false })

    expect(harness.rendered).toHaveLength(1)
    expect(harness.focused).toEqual([])
  })

  it('rejects stale preview completions after a newer preview starts', async () => {
    const first = deferred<RouteMapVariant | undefined>()
    const harness = createHarness({
      loadVariant: async (_city, routeName) => routeName === 'OLD' ? first.promise : variant(routeName),
    })

    const oldPreview = harness.controller.preview(directState([directRoute('OLD')]), { fitCamera: true })
    const newPreview = harness.controller.preview(directState([directRoute('NEW')]), { fitCamera: true })
    await expect(newPreview).resolves.toBe(true)
    first.resolve(variant('OLD'))
    await expect(oldPreview).resolves.toBe(false)

    expect(harness.rendered.map((entry) => entry.variant.routeName)).toEqual(['NEW'])
    expect(harness.focused).toHaveLength(1)
  })

  it('suppresses errors from cancelled or city-stale work but preserves active failures', async () => {
    const cancelledFailure = deferred<RouteMapVariant | undefined>()
    const cancelled = createHarness({ loadVariant: () => cancelledFailure.promise })
    const cancelledPreview = cancelled.controller.preview(directState([directRoute('OLD')]), { fitCamera: true })
    cancelled.controller.cancel()
    cancelledFailure.reject(new Error('cancelled'))
    await expect(cancelledPreview).resolves.toBe(false)

    const cityFailure = deferred<RouteMapVariant | undefined>()
    const changedCity = createHarness({ loadVariant: () => cityFailure.promise })
    const cityPreview = changedCity.controller.preview(directState([directRoute('CITY')]), { fitCamera: true })
    changedCity.setCityCode('NewTaipei')
    cityFailure.reject(new Error('wrong city'))
    await expect(cityPreview).resolves.toBe(false)

    const activeError = new Error('active failure')
    const active = createHarness({ loadVariant: async () => { throw activeError } })
    await expect(active.controller.preview(directState([directRoute('ACTIVE')]), { fitCamera: true }))
      .rejects.toBe(activeError)
  })

  it('rejects invalid direct preview limits', () => {
    expect(() => createHarness({ directPreviewLimit: 0 })).toThrow('positive integer')
  })
})
