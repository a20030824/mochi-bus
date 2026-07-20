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
    edits.push({ start: node.getFullStart(), end: node.end, text: `\n${replacement}\n` })
  }
  return applyEdits(text, edits)
}

const statePath = 'web/map/trip-state.ts'
let stateSource = fs.readFileSync(statePath, 'utf8')
stateSource = stateSource.replace(
  "  to: TripEndpoint\n  pending: TripPendingSelections\n}",
  "  to: TripEndpoint\n  warning?: TDXWarning\n  pending: TripPendingSelections\n}",
)
stateSource = stateSource.replace(
  "      to,\n      pending,\n    }",
  "      to,\n      warning: undefined,\n      pending,\n    }",
)
const warningAnchor = `export function selectDirectTripResult(state: TripResultsState, index: number): TripResultsState {`
if (!stateSource.includes(warningAnchor)) throw new Error('Missing trip warning insertion anchor')
stateSource = stateSource.replace(warningAnchor, `export function setTripWarning(state: TripState, warning: TDXWarning | undefined): TripState {
  if (state.phase !== 'loading' && state.phase !== 'results') return state
  return { ...state, warning }
}

${warningAnchor}`)
fs.writeFileSync(statePath, stateSource)

const storePath = 'web/map/trip-runtime-store.ts'
let storeSource = fs.readFileSync(storePath, 'utf8')
storeSource = storeSource.replace(
  '  focus(kind: TripSelectionKind): void\n',
  '  focus(kind: TripSelectionKind): void\n  reselect(kind: TripSelectionKind): void\n',
)
storeSource = storeSource.replace(
  '    focus,\n    selectEndpoint,\n',
  `    focus,
    reselect(kind) {
      current = resumeTripEndpoint(current, kind)
    },
    selectEndpoint,
`,
)
fs.writeFileSync(storePath, storeSource)

const mainPath = 'web/map/main.ts'
let source = fs.readFileSync(mainPath, 'utf8')
source = source.replace(
  `import {
  createTripResultsState,
  hasTripResultsState,
  type TripPendingSelection,
} from './trip-state'
`,
  `import type { TripPendingSelection } from './trip-state'
import { createTripRuntimeStore } from './trip-runtime-store'
`,
)
source = source.replace(
  "import { tdxWarningMessages, type TDXWarning } from '../../src/domain/tdx-warning'",
  "import { tdxWarningMessages } from '../../src/domain/tdx-warning'",
)

const globals = `let selectedFrom: NearbyPlace | undefined
let selectedTo: NearbyPlace | undefined
let fromCoordinate: [number, number] | undefined
let toCoordinate: [number, number] | undefined
let tripStage: 'idle' | 'from' | 'to' = 'idle'
let tripSelecting = false
let lastDirectRoutes: DirectRoute[] = []
let lastTransferPlans: TransferPlan[] = []
let journeyWarning: TDXWarning | undefined`
if (!source.includes(globals)) throw new Error('Missing Trip globals block')
source = source.replace(globals, `const trip = createTripRuntimeStore()
let tripSelecting = false`)
source = source.replace(
  `let selectedTransferIndex = 0
let selectedDirectIndex = 0
let pendingFromSelection: TripPendingSelection | undefined
let pendingToSelection: TripPendingSelection | undefined
`,
  '',
)

const replacements = {
  pendingTripSelection: `function pendingTripSelection(kind: TripSelectionKind): TripPendingSelection | undefined {
  return trip.pending(kind)
}`,
  setPendingTripSelection: `function setPendingTripSelection(selection: TripPendingSelection) {
  trip.setPending(selection)
}`,
  clearPendingTripSelection: `function clearPendingTripSelection(kind: TripSelectionKind) {
  trip.clearPending(kind)
}`,
  clearPendingTripSelections: `function clearPendingTripSelections() {
  trip.clearPending()
}`,
  applyTripSelection: `async function applyTripSelection(
  kind: TripSelectionKind,
  candidate: NearbyPlace,
  coordinate: [number, number],
): Promise<boolean> {
  const conflict = tripSelectionConflict(kind, candidate)
  if (conflict) {
    setStatus(conflict, true)
    return false
  }
  const ready = trip.selectEndpoint(kind, candidate, coordinate)
  if (ready) {
    interactionMode = 'trip-results'
    cityNetwork.hide()
    nearbyLayer.clearLayers()
    drawTripEndpoints()
    await loadDirectRoutes()
    return true
  }
  renderTripSelectionStep(kind === 'from' ? 'to' : 'from')
  return true
}`,
  clearTripState: `function clearTripState() {
  trip.reset()
  clearTripResultsCamera()
}`,
  normalizeDirectIndex: `function normalizeDirectIndex(directRoutes: DirectRoute[]): number {
  if (!directRoutes.length) return 0
  return Math.min(Math.max(trip.selectedDirectIndex, 0), directRoutes.length - 1)
}`,
  hasTripResults: `function hasTripResults(): boolean {
  return trip.hasResults()
}`,
  loadDirectRoutes: `async function loadDirectRoutes() {
  const from = trip.from
  const to = trip.to
  if (!activeCity || !from || !to) return
  clearTripResultsCamera()
  const { requestId, signal } = beginNavRequest()
  trip.setWarning(undefined)
  setStatus(\`正在找 \${from.name} → \${to.name} 的直達車…\`)
  try {
    const directRoutes = await mapApi.direct(activeCity.code, from.placeId, to.placeId, signal)
    if (isStaleNav(requestId)) return
    if (directRoutes.length) {
      const rankedRoutes = await rankDirectRoutesByEta(directRoutes, signal)
      if (isStaleNav(requestId)) return
      trip.completeDirect(rankedRoutes)
      renderDirectRoutes(rankedRoutes)
      await previewDirectRoutes(rankedRoutes, { fitCamera: true })
      return
    }
    setStatus('沒有直達車，正在找一次轉乘…')
    const transferPlans = await mapApi.transfer(activeCity.code, from.placeId, to.placeId, signal)
    if (isStaleNav(requestId)) return
    const rankedPlans = await rankTransferPlansByEta(transferPlans, signal)
    if (isStaleNav(requestId)) return
    if (rankedPlans.length) trip.completeTransfer(rankedPlans)
    else trip.completeEmpty()
    renderTransferPlans(rankedPlans)
    await previewTransferPlans(rankedPlans, { fitCamera: true })
  } catch (error) {
    if (isStaleNav(requestId)) return
    const message = error instanceof Error && error.message ? error.message : '直達路線查詢失敗'
    const credentialRejected = isTdxTokenRejectedError(error)
    setStatus(message, true)
    renderDrawer({
      key: \`trip-results:\${from.placeId}:\${to.placeId}\`,
      mode: 'compact',
      content: [
        drawerBack('重新選目的地', resumeDestinationSelection),
        heading('查詢失敗了', \`\${from.name} → \${to.name} 暫時查不到，稍等一下再試。\`),
        degradedNotice(message, () => void loadDirectRoutes(), credentialRejected),
      ],
    })
  }
}`,
  writeTripResultsUrl: `function writeTripResultsUrl() {
  if (!activeCity) return
  const results = trip.results()
  if (!results) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  const snapshot = createTripResultsSnapshot(activeCity.code, results)
  history.replaceState({
    ...currentState,
    mapView: 'trip-results',
    tripResults: snapshot,
  }, '', \`/map?city=\${encodeURIComponent(activeCity.code)}&trip=results&from=\${encodeURIComponent(results.from.place.placeId)}&to=\${encodeURIComponent(results.to.place.placeId)}\`)
  setDocumentTitle(\`\${results.from.place.name} → \${results.to.place.name}\`)
}`,
  restoreTripResultsState: `function restoreTripResultsState(params?: URLSearchParams): boolean {
  if (!activeCity) return false
  const restored = parseTripResultsSnapshot(history.state?.tripResults, {
    city: activeCity.code,
    fromPlaceId: params?.get('from'),
    toPlaceId: params?.get('to'),
  })
  if (!restored) return false
  trip.restore(restored)
  interactionMode = 'trip-results'
  return trip.hasResults()
}`,
  restoreSharedTripResults: `async function restoreSharedTripResults(
  params: URLSearchParams,
  signal?: AbortSignal,
  isStale: () => boolean = () => false,
): Promise<boolean> {
  if (!activeCity) return false
  const cityCode = activeCity.code
  const fromPlaceId = params.get('from')
  const toPlaceId = params.get('to')
  if (!fromPlaceId || !toPlaceId || fromPlaceId === toPlaceId) return false
  const [from, to] = await Promise.all([
    mapApi.place(cityCode, fromPlaceId, signal),
    mapApi.place(cityCode, toPlaceId, signal),
  ])
  if (signal?.aborted || isStale() || activeCity?.code !== cityCode) return false
  trip.begin(
    { place: from, coordinate: [from.latitude, from.longitude] },
    { place: to, coordinate: [to.latitude, to.longitude] },
  )
  interactionMode = 'trip-results'
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  history.replaceState({ ...currentState, mapView: 'trip-results', mapParent: 'catalogue' }, '', location.href)
  await loadDirectRoutes()
  return true
}`,
  resumeDestinationSelection: `function resumeDestinationSelection() {
  clearTripResultsCamera()
  trip.reselect('to')
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  renderTripSelectionStep('to')
}`,
  resumeOriginSelection: `function resumeOriginSelection() {
  clearTripResultsCamera()
  trip.reselect('from')
  interactionMode = 'trip'
  previewLayer.clearLayers()
  nearbyLayer.clearLayers()
  renderTripSelectionStep('from')
}`,
}
source = replaceFunctions(mainPath, source, replacements)

const resetBlock = `selectedFrom = undefined
  selectedTo = undefined
  fromCoordinate = undefined
  toCoordinate = undefined
  tripStage = 'idle'
  lastDirectRoutes = []
  lastTransferPlans = []
  selectedDirectIndex = 0`
source = source.replaceAll(resetBlock, 'trip.reset()')
source = source.replace(
  `clearTripResultsCamera()
    clearPendingTripSelections()
    selectedFrom = undefined
    selectedTo = undefined
    fromCoordinate = undefined
    toCoordinate = undefined
    lastDirectRoutes = []
    lastTransferPlans = []
    selectedDirectIndex = 0
    tripStage = 'from'`,
  `clearTripResultsCamera()
    trip.start()`,
)
source = source.replace('  tripStage = nextKind\n', '  trip.focus(nextKind)\n')
source = source.replaceAll('journeyWarning = response.warning', 'trip.setWarning(response.warning)')
source = source.replaceAll("journeyWarning = 'tdx-unavailable'", "trip.setWarning('tdx-unavailable')")
source = source.replaceAll('selectedDirectIndex = selectedIndex', 'trip.selectDirect(selectedIndex)')
source = source.replaceAll('selectedDirectIndex = index', 'trip.selectDirect(index)')
source = source.replaceAll('selectedDirectIndex = preview.index', 'trip.selectDirect(preview.index)')
source = source.replaceAll('selectedTransferIndex = index', 'trip.selectTransfer(index)')

const identifiers = {
  selectedFrom: 'trip.from',
  selectedTo: 'trip.to',
  fromCoordinate: 'trip.fromCoordinate',
  toCoordinate: 'trip.toCoordinate',
  tripStage: 'trip.stage',
  lastDirectRoutes: 'trip.directRoutes',
  lastTransferPlans: 'trip.transferPlans',
  journeyWarning: 'trip.warning',
  selectedDirectIndex: 'trip.selectedDirectIndex',
  selectedTransferIndex: 'trip.selectedTransferIndex',
}
for (const [name, replacement] of Object.entries(identifiers)) {
  source = source.replace(new RegExp(`\\b${name}\\b`, 'g'), replacement)
}
source = source.replace(/\n{4,}/g, '\n\n\n')
fs.writeFileSync(mainPath, source)

const sizePath = 'web/map/main-size.test.ts'
let sizeSource = fs.readFileSync(sizePath, 'utf8')
const lineCount = source.split(/\r?\n/).length
sizeSource = sizeSource.replace(/const MAP_MAIN_LINE_LIMIT = \d+/, `const MAP_MAIN_LINE_LIMIT = ${lineCount}`)
fs.writeFileSync(sizePath, sizeSource)
console.log(`main.ts line limit: ${lineCount}`)
