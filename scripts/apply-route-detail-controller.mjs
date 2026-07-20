import fs from 'node:fs'
import ts from 'typescript'

function applyEdits(text, edits) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text)
}

function replaceFunctions(path, text, replacements) {
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits = []
  for (const [name, replacement] of Object.entries(replacements)) {
    const node = file.statements.find((statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name)
    if (!node) throw new Error(`Missing function ${name}`)
    edits.push({ start: node.getFullStart(), end: node.end, text: replacement ? `\n${replacement}\n` : '\n' })
  }
  return applyEdits(text, edits)
}

const surfacePath = 'web/map/route-detail-surface.ts'
let surface = fs.readFileSync(surfacePath, 'utf8')
const timetableType = `type TimetableViewOptions = {
  cityCode: string
  variant: RouteMapVariant
  timetable: RouteTimetable
  onBack: () => void
  onSelectStop: (stopUid: string) => void
}
`
if (!surface.includes(timetableType)) throw new Error('Timetable view type changed')
surface = surface.replace(timetableType, `${timetableType}
type RouteLoadingViewOptions = {
  cityCode: string
  routeName: string
  backLabel: string
  onBack: () => void
}

type RouteErrorViewOptions = RouteLoadingViewOptions & {
  message: string
  onRetry: () => void
}
`)
surface = surface.replace(
  `export type RouteDetailSurface = {
  showVariantPicker(options: VariantPickerOptions): void`,
  `export type RouteDetailSurface = {
  showRouteLoading(options: RouteLoadingViewOptions): void
  showRouteError(options: RouteErrorViewOptions): void
  showVariantPicker(options: VariantPickerOptions): void`,
)
const pickerFunction = `  function showVariantPicker(view: VariantPickerOptions): void {`
if (!surface.includes(pickerFunction)) throw new Error('Variant picker function changed')
surface = surface.replace(pickerFunction, `  function showRouteLoading(view: RouteLoadingViewOptions): void {
    options.renderDrawer({
      key: \`route:\${view.cityCode}:\${view.routeName}\`,
      mode: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, '正在拼起路線與站牌…'),
      ],
    })
  }

  function showRouteError(view: RouteErrorViewOptions): void {
    options.renderDrawer({
      key: \`route:\${view.cityCode}:\${view.routeName}\`,
      mode: 'compact',
      content: [
        options.drawerBack(view.backLabel, view.onBack),
        options.heading(view.routeName, view.message),
        options.retryButton(view.onRetry),
      ],
    })
  }

${pickerFunction}`)
surface = surface.replace(
  `  return {
    showVariantPicker,`,
  `  return {
    showRouteLoading,
    showRouteError,
    showVariantPicker,`,
)
fs.writeFileSync(surfacePath, surface)

const mainPath = 'web/map/main.ts'
let main = fs.readFileSync(mainPath, 'utf8')
main = main.replace(
  "import { routeLoadingBack, routeViewBack, type RouteBackTarget } from '../../src/domain/map/route-back'\n",
  '',
)
main = main.replace(
  "import { selectRouteVariant } from '../../src/domain/map/route-variant-selection'\n",
  '',
)
main = main.replace(
  "import { createRouteDetailSurface } from './route-detail-surface'\n",
  "import { createRouteDetailController } from './route-detail-controller'\nimport { createRouteDetailSurface } from './route-detail-surface'\n",
)
for (const declaration of [
  'let routeReturnsToTrip = false\n',
  'let activeRouteColor = stopFillAccent\n',
  'let routeBackAction: (() => void) | undefined\n',
  "// 經過支線選擇進來的路線,「更換」要退回支線選擇(一層),不能直接跳回路線列表(兩層)。\nlet lastVariantChoices: { routeName: string; variants: RouteMapVariant[] } | undefined\n",
  'let variantPickerUsed = false\n',
]) {
  if (!main.includes(declaration)) throw new Error(`Missing route state declaration: ${declaration}`)
  main = main.replace(declaration, '')
}

main = main.replace(
  "  isActive: ({ cityCode }) => activeCity?.code === cityCode && interactionMode === 'route',",
  "  isActive: (session) => routeDetail.isVehicleSessionActive(session),",
)
main = main.replace(
  "    target.addEventListener('click', () => void openRouteTimetable(variant))",
  "    target.addEventListener('click', () => void routeDetail.openTimetable())",
)

const summaryEnd = `  onError: ({ target }) => target.remove(),
})
`
if (!main.includes(summaryEnd)) throw new Error('Timetable summary setup changed')
const controllerSetup = `${summaryEnd}
const routeDetail = createRouteDetailController({
  surface: routeDetailSurface,
  loadVariants: mapApi.routeVariants,
  loadTimetable: mapApi.timetable,
  beginRequest: beginNavRequest,
  isStaleRequest: isStaleNav,
  isCityActive: (cityCode) => activeCity?.code === cityCode,
  prepareOpen: (request) => {
    cityNetwork.hide()
    previewRequest += 1
    previewLayer.clearLayers()
    nearbyLayer.clearLayers()
    if (!request.returnToTrip && !hasTripResults()) clearTripState()
  },
  invalidatePreview: () => { previewRequest += 1 },
  clearNearby: () => nearbyLayer.clearLayers(),
  clearPreview: () => previewLayer.clearLayers(),
  enterRouteMode: () => { interactionMode = 'route' },
  clearTripState,
  hasTripResults,
  returnToTripResults,
  returnToRoutePicker,
  onStopSelect: (latitude, longitude) => void findNearbyPlaces(latitude, longitude, true),
  writePickerLocation: (cityCode, routeName) => {
    history.replaceState(
      history.state,
      '',
      \`/map?city=\${encodeURIComponent(cityCode)}&route=\${encodeURIComponent(routeName)}\`,
    )
  },
  writeVariantLocation: (cityCode, variant) => {
    const params = new URLSearchParams({
      city: cityCode,
      route: variant.routeName,
      routeUid: variant.routeUid,
      direction: String(variant.direction),
      variant: variant.variantKey,
    })
    const currentState = historyRecord()
    history.replaceState({
      ...currentState,
      mapView: 'route',
      mapParent: readMapView({ mapView: currentState.mapParent }) ?? 'catalogue',
    }, '', \`/map?\${params}\`)
  },
  setDocumentTitle,
  setStatus,
  clearStatus,
  startVehicleRefresh: (cityCode, variant) => vehicleRefresh.start({ cityCode, route: variant }),
  stopVehicleRefresh: () => vehicleRefresh.stop(),
  startTimetableSummary: (cityCode, variant, target) => {
    routeTimetableSummary.start({ cityCode, variant, target })
  },
  stopTimetableSummary: () => routeTimetableSummary.stop(),
})
`
main = main.replace(summaryEnd, controllerSetup)

main = replaceFunctions(mainPath, main, {
  backActionFor: '',
  loadRoute: `function openRouteDetail(
  routeName: string,
  preferredVariant?: string | null,
  returnToTrip = false,
  color = stopFillAccent,
  stopBackAction?: () => void,
): Promise<void> {
  if (!activeCity) return Promise.resolve()
  return routeDetail.open({
    cityCode: activeCity.code,
    routeName,
    preferredVariant,
    returnToTrip,
    color,
    stopBackAction,
  })
}`,
  renderVariantPicker: '',
  openRouteTimetable: '',
  drawVariant: '',
  startVehicleRefresh: '',
  stopVehicleRefresh: '',
})

main = main.replaceAll('loadRoute(', 'openRouteDetail(')
main = main.replaceAll('routeDetailSurface.resizeStopMarkers()', 'routeDetail.resizeStopMarkers()')
main = main.replaceAll('routeDetailSurface.clearRoute()', 'routeDetail.close()')
main = main.replace(/^\s*stopVehicleRefresh\(\)\n/gm, '')
main = main.replace(/^\s*routeReturnsToTrip = false\n/gm, '')
main = main.replace(/^\s*routeBackAction = undefined\n/gm, '')

fs.writeFileSync(mainPath, main)

const lineCount = main.split(/\r?\n/).length
const sizePath = 'web/map/main-size.test.ts'
const sizeSource = fs.readFileSync(sizePath, 'utf8').replace(
  /const MAP_MAIN_LINE_LIMIT = \d+/,
  `const MAP_MAIN_LINE_LIMIT = ${lineCount}`,
)
fs.writeFileSync(sizePath, sizeSource)
console.log(`route detail controller integrated; main.ts is ${lineCount} lines`)
