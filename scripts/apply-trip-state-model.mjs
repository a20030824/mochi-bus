import fs from 'node:fs'
import ts from 'typescript'

const mainPath = 'web/map/main.ts'
let source = fs.readFileSync(mainPath, 'utf8')

source = source.replace(
  "import { getTripSelectionConflict, type TripSelectionKind } from '../../src/domain/map/trip-selection'\n",
  "import { getTripSelectionConflict, type TripSelectionKind } from '../../src/domain/map/trip-selection'\n"
    + "import {\n"
    + "  createTripResultsState,\n"
    + "  hasTripResultsState,\n"
    + "  type TripPendingSelection,\n"
    + "} from './trip-state'\n"
    + "import { createTripResultsSnapshot, parseTripResultsSnapshot } from './trip-results-snapshot'\n",
)
source = source.replace('  type TransferEstimate,\n', '')

const replacements = {
  writeTripResultsUrl: `function writeTripResultsUrl() {
  if (!activeCity || !selectedFrom || !selectedTo) return
  const currentState = history.state && typeof history.state === 'object' ? history.state : {}
  const tripState = createTripResultsState({
    from: { place: selectedFrom, coordinate: fromCoordinate },
    to: { place: selectedTo, coordinate: toCoordinate },
    directRoutes: lastDirectRoutes,
    transferPlans: lastTransferPlans,
    selectedDirectIndex,
    selectedTransferIndex,
    warning: journeyWarning,
  })
  const snapshot = createTripResultsSnapshot(activeCity.code, tripState)
  history.replaceState({
    ...currentState,
    mapView: 'trip-results',
    tripResults: snapshot,
  }, '', \`/map?city=\${encodeURIComponent(activeCity.code)}&trip=results&from=\${encodeURIComponent(selectedFrom.placeId)}&to=\${encodeURIComponent(selectedTo.placeId)}\`)
  setDocumentTitle(\`\${selectedFrom?.name ?? '出發地'} → \${selectedTo?.name ?? '目的地'}\`)
}`,
  restoreTripResultsState: `function restoreTripResultsState(params?: URLSearchParams): boolean {
  if (!activeCity) return false
  const restored = parseTripResultsSnapshot(history.state?.tripResults, {
    city: activeCity.code,
    fromPlaceId: params?.get('from'),
    toPlaceId: params?.get('to'),
  })
  if (!restored) return false
  selectedFrom = restored.from.place
  selectedTo = restored.to.place
  fromCoordinate = restored.from.coordinate
  toCoordinate = restored.to.coordinate
  lastDirectRoutes = restored.directRoutes
  lastTransferPlans = restored.transferPlans
  selectedDirectIndex = restored.selectedDirectIndex
  selectedTransferIndex = restored.selectedTransferIndex
  journeyWarning = restored.warning
  tripStage = 'idle'
  interactionMode = 'trip-results'
  return hasTripResultsState(restored)
}`,
}

const removeFunctions = new Set([
  'isHistoryPlace',
  'isHistoryLeg',
  'isHistoryEtaSource',
  'isHistoryMinute',
  'isHistoryHeadway',
  'isHistoryDirectRoute',
  'isHistoryTransferEstimate',
  'isHistoryTransferPlan',
])
const removeTypes = new Set([
  'TripResultsHistorySnapshot',
  'PendingTripSelection',
])

const file = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const edits = []
for (const statement of file.statements) {
  if (ts.isTypeAliasDeclaration(statement) && removeTypes.has(statement.name.text)) {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: '' })
    continue
  }
  if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
  const name = statement.name.text
  if (name in replacements) {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: `\n${replacements[name]}\n` })
  } else if (removeFunctions.has(name)) {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: '' })
  }
}

for (const required of [...Object.keys(replacements), ...removeFunctions]) {
  const found = file.statements.some((statement) =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === required)
  if (!found) throw new Error(`Missing function ${required}`)
}
for (const required of removeTypes) {
  const found = file.statements.some((statement) =>
    ts.isTypeAliasDeclaration(statement) && statement.name.text === required)
  if (!found) throw new Error(`Missing type ${required}`)
}

source = [...edits]
  .sort((a, b) => b.start - a.start)
  .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source)
source = source.replace(/\bPendingTripSelection\b/g, 'TripPendingSelection')
source = source.replace(/\n{4,}/g, '\n\n\n')
fs.writeFileSync(mainPath, source)

const sizePath = 'web/map/main-size.test.ts'
let sizeSource = fs.readFileSync(sizePath, 'utf8')
const lineCount = source.split(/\r?\n/).length
sizeSource = sizeSource.replace(
  /const MAP_MAIN_LINE_LIMIT = \d+/,
  `const MAP_MAIN_LINE_LIMIT = ${lineCount}`,
)
fs.writeFileSync(sizePath, sizeSource)
console.log(`main.ts line limit: ${lineCount}`)
