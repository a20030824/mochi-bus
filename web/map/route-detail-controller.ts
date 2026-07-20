import { routeLoadingBack, routeViewBack, type RouteBackTarget } from '../../src/domain/map/route-back'
import { selectRouteVariant } from '../../src/domain/map/route-variant-selection'
import type {
  RouteMapVariant,
  RouteTimetableResponse,
} from './map-api-client'
import type { RouteDetailSurface } from './route-detail-surface'

export type RouteDetailOpenRequest = Readonly<{
  cityCode: string
  routeName: string
  preferredVariant?: string | null
  returnToTrip?: boolean
  color: string
  stopBackAction?: () => void
}>

type RouteDetailSession = {
  request: RouteDetailOpenRequest
  variants?: RouteMapVariant[]
  selectedVariant?: RouteMapVariant
  pickerUsed: boolean
}

type RequestTicket = {
  requestId: number
  signal: AbortSignal
}

type RouteDetailControllerOptions = {
  surface: RouteDetailSurface
  loadVariants: (
    cityCode: string,
    routeName: string,
    signal?: AbortSignal,
  ) => Promise<RouteMapVariant[]>
  loadTimetable: (
    cityCode: string,
    variant: RouteMapVariant,
    stopUid?: string,
    signal?: AbortSignal,
  ) => Promise<RouteTimetableResponse>
  beginRequest: () => RequestTicket
  isStaleRequest: (requestId: number) => boolean
  isCityActive: (cityCode: string) => boolean
  prepareOpen: (request: RouteDetailOpenRequest) => void
  invalidatePreview: () => void
  clearNearby: () => void
  clearPreview: () => void
  enterRouteMode: () => void
  clearTripState: () => void
  hasTripResults: () => boolean
  returnToTripResults: () => void
  returnToRoutePicker: () => void
  onStopSelect: (latitude: number, longitude: number) => void
  writePickerLocation: (cityCode: string, routeName: string) => void
  writeVariantLocation: (cityCode: string, variant: RouteMapVariant) => void
  setDocumentTitle: (title: string) => void
  setStatus: (text: string, error?: boolean) => void
  clearStatus: () => void
  startVehicleRefresh: (cityCode: string, variant: RouteMapVariant) => void
  stopVehicleRefresh: () => void
  startTimetableSummary: (
    cityCode: string,
    variant: RouteMapVariant,
    target: HTMLButtonElement,
  ) => void
  stopTimetableSummary: () => void
}

export type RouteDetailController = {
  open(request: RouteDetailOpenRequest): Promise<void>
  openTimetable(stopUid?: string): Promise<void>
  showVariant(variant: RouteMapVariant): void
  showVariantPicker(): void
  close(): void
  resizeStopMarkers(): void
  isVehicleSessionActive(session: { cityCode: string; route: RouteMapVariant }): boolean
}

type RouteDetailView = 'idle' | 'loading' | 'picker' | 'route' | 'timetable'

export function createRouteDetailController(
  options: RouteDetailControllerOptions,
): RouteDetailController {
  let session: RouteDetailSession | undefined
  let view: RouteDetailView = 'idle'

  function isCurrent(candidate: RouteDetailSession): boolean {
    return session === candidate && options.isCityActive(candidate.request.cityCode)
  }

  function stopEnhancements(): void {
    options.stopTimetableSummary()
    options.stopVehicleRefresh()
  }

  function backActionFor(target: RouteBackTarget): () => void {
    if (target === 'trip-results') return options.returnToTripResults
    if (target === 'variant-picker') {
      return () => {
        if (session?.variants) showVariantPicker()
        else options.returnToRoutePicker()
      }
    }
    if (target === 'stop-view') {
      return () => (session?.request.stopBackAction ?? options.returnToRoutePicker)()
    }
    return options.returnToRoutePicker
  }

  async function open(request: RouteDetailOpenRequest): Promise<void> {
    stopEnhancements()
    const nextSession: RouteDetailSession = {
      request: { ...request, returnToTrip: request.returnToTrip ?? false },
      pickerUsed: false,
    }
    session = nextSession
    view = 'loading'
    options.prepareOpen(nextSession.request)

    const loading = routeLoadingBack({
      returnToTrip: Boolean(nextSession.request.returnToTrip),
      hasStopBackAction: Boolean(nextSession.request.stopBackAction),
    })
    const loadingBack = backActionFor(loading.target)
    options.surface.showRouteLoading({
      cityCode: nextSession.request.cityCode,
      routeName: nextSession.request.routeName,
      backLabel: loading.label,
      onBack: loadingBack,
    })
    options.setStatus(`${nextSession.request.routeName} · 正在讀取城市裡的路徑…`)

    const { requestId, signal } = options.beginRequest()
    try {
      const variants = await options.loadVariants(
        nextSession.request.cityCode,
        nextSession.request.routeName,
        signal,
      )
      if (signal.aborted || options.isStaleRequest(requestId) || !isCurrent(nextSession)) return

      const selection = selectRouteVariant(variants, nextSession.request.preferredVariant)
      nextSession.variants = variants
      nextSession.pickerUsed = selection.pickerUsed
      if (selection.kind === 'variant') showVariant(selection.variant)
      else showVariantPicker()
    } catch (error) {
      if (signal.aborted || options.isStaleRequest(requestId) || !isCurrent(nextSession)) return
      const message = error instanceof Error && error.message
        ? error.message
        : '目前無法取得這條路線。'
      options.setStatus(message, true)
      options.surface.showRouteError({
        cityCode: nextSession.request.cityCode,
        routeName: nextSession.request.routeName,
        message,
        backLabel: loading.label,
        onBack: loadingBack,
        onRetry: () => void open(nextSession.request),
      })
    }
  }

  function showVariantPicker(): void {
    const currentSession = session
    if (!currentSession?.variants || !isCurrent(currentSession)) {
      options.returnToRoutePicker()
      return
    }

    stopEnhancements()
    view = 'picker'
    options.invalidatePreview()
    options.clearNearby()
    const decision = routeLoadingBack({
      returnToTrip: Boolean(currentSession.request.returnToTrip),
      hasStopBackAction: Boolean(currentSession.request.stopBackAction),
    })
    options.surface.showVariantPicker({
      cityCode: currentSession.request.cityCode,
      routeName: currentSession.request.routeName,
      variants: currentSession.variants,
      backLabel: decision.label,
      onBack: backActionFor(decision.target),
      onSelect: showVariant,
    })
    options.clearStatus()
    options.writePickerLocation(currentSession.request.cityCode, currentSession.request.routeName)
  }

  function showVariant(variant: RouteMapVariant): void {
    const currentSession = session
    if (!currentSession || !isCurrent(currentSession)) return

    currentSession.selectedVariant = variant
    view = 'route'
    options.enterRouteMode()
    if (!currentSession.request.returnToTrip) options.clearTripState()
    options.clearNearby()
    options.clearPreview()
    options.clearStatus()

    const canReturnToVariantPicker = !currentSession.request.returnToTrip
      && currentSession.pickerUsed
      && currentSession.request.routeName === variant.routeName
      && (currentSession.variants?.length ?? 0) > 1
    const backContext = () => ({
      returnToTrip: Boolean(currentSession.request.returnToTrip),
      hasTripResults: options.hasTripResults(),
      canReturnToVariantPicker,
      hasStopBackAction: Boolean(currentSession.request.stopBackAction),
    })
    const backDecision = routeViewBack(backContext())
    const timetableSummary = options.surface.showRoute({
      cityCode: currentSession.request.cityCode,
      variant,
      color: currentSession.request.color,
      backLabel: backDecision.label,
      onBack: () => backActionFor(routeViewBack(backContext()).target)(),
      onStopSelect: options.onStopSelect,
    })
    options.startTimetableSummary(currentSession.request.cityCode, variant, timetableSummary)
    options.writeVariantLocation(currentSession.request.cityCode, variant)
    options.setDocumentTitle(`${variant.routeName} 公車路線圖`)
    options.startVehicleRefresh(currentSession.request.cityCode, variant)
  }

  async function openTimetable(stopUid?: string): Promise<void> {
    const currentSession = session
    const variant = currentSession?.selectedVariant
    if (!currentSession || !variant || !isCurrent(currentSession)) return

    stopEnhancements()
    view = 'timetable'
    const back = () => showVariant(variant)
    options.surface.showTimetableLoading(
      currentSession.request.cityCode,
      variant,
      stopUid,
      back,
    )
    options.setStatus(`${variant.routeName} · 正在讀取時刻`)

    const { requestId, signal } = options.beginRequest()
    try {
      const data = await options.loadTimetable(
        currentSession.request.cityCode,
        variant,
        stopUid,
        signal,
      )
      if (
        signal.aborted
        || options.isStaleRequest(requestId)
        || !isCurrent(currentSession)
        || currentSession.selectedVariant !== variant
        || view !== 'timetable'
      ) return

      const result = options.surface.showTimetable({
        cityCode: currentSession.request.cityCode,
        variant,
        timetable: data.timetable,
        onBack: back,
        onSelectStop: (nextStopUid) => void openTimetable(nextStopUid),
      })
      if (result.available) options.clearStatus()
      else options.setStatus(`${variant.routeName} · 無公開時刻資料`)
    } catch (error) {
      if (
        signal.aborted
        || options.isStaleRequest(requestId)
        || !isCurrent(currentSession)
        || currentSession.selectedVariant !== variant
        || view !== 'timetable'
      ) return
      const message = error instanceof Error ? error.message : '目前無法取得時刻表'
      options.surface.showTimetableError(
        currentSession.request.cityCode,
        variant,
        stopUid,
        message,
        back,
        () => void openTimetable(stopUid),
      )
      options.setStatus(message, true)
    }
  }

  function close(): void {
    session = undefined
    view = 'idle'
    stopEnhancements()
    options.surface.clearRoute()
    options.surface.clearSelection()
  }

  function isVehicleSessionActive(candidate: {
    cityCode: string
    route: RouteMapVariant
  }): boolean {
    return view === 'route'
      && session?.request.cityCode === candidate.cityCode
      && session.selectedVariant?.variantKey === candidate.route.variantKey
      && options.isCityActive(candidate.cityCode)
  }

  return {
    open,
    openTimetable,
    showVariant,
    showVariantPicker,
    close,
    resizeStopMarkers: () => options.surface.resizeStopMarkers(),
    isVehicleSessionActive,
  }
}
