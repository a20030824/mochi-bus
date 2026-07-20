import fs from 'node:fs'
import ts from 'typescript'

function applyEdits(text, edits) {
  return [...edits]
    .sort((a, b) => b.start - a.start)
    .reduce((result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text)
}

const mainPath = 'web/map/main.ts'
let source = fs.readFileSync(mainPath, 'utf8')

source = source.replace(
  `import {
  describeTransferEstimate,
  estimateTransfer,
  transferEstimateSortKey,
} from '../../src/domain/map/transfer-estimate'`,
  `import { describeTransferEstimate } from '../../src/domain/map/transfer-estimate'`,
)
source = source.replace(
  `import {
  formatJourneyWait,
  splitEtaLabel,
  type EtaSource,
} from '../../src/domain/eta-presentation'`,
  `import { formatJourneyWait, splitEtaLabel } from '../../src/domain/eta-presentation'`,
)
source = source.replace('  type JourneyEtaEstimate,\n', '')
source = source.replace(
  "import { createTripRuntimeStore } from './trip-runtime-store'\n",
  "import { createTripRuntimeStore } from './trip-runtime-store'\n"
    + "import { createTripPlanLoader } from './trip-plan-loader'\n",
)
source = source.replace(
  'const trip = createTripRuntimeStore()\n',
  `const trip = createTripRuntimeStore()
const tripPlanLoader = createTripPlanLoader({
  loadDirect: mapApi.direct,
  loadTransfer: mapApi.transfer,
  loadJourneyEta: mapApi.journeyEta,
  isCredentialRejectedError: isTdxTokenRejectedError,
})
`,
)

const loadDirectRoutes = `async function loadDirectRoutes() {
  const from = trip.from
  const to = trip.to
  if (!activeCity || !from || !to) return
  clearTripResultsCamera()
  const { requestId, signal } = beginNavRequest()
  trip.setWarning(undefined)
  setStatus(\`正在找 \${from.name} → \${to.name} 的直達車…\`)
  try {
    const result = await tripPlanLoader.load({
      cityCode: activeCity.code,
      fromPlaceId: from.placeId,
      toPlaceId: to.placeId,
      signal,
      onPhase: (phase) => {
        if (phase === 'transfer') setStatus('沒有直達車，正在找一次轉乘…')
      },
    })
    if (isStaleNav(requestId) || !result) return
    trip.setWarning(result.warning)
    if (result.kind === 'direct') {
      trip.completeDirect(result.routes)
      renderDirectRoutes(result.routes)
      await previewDirectRoutes(result.routes, { fitCamera: true })
      return
    }
    if (result.kind === 'transfer') {
      trip.completeTransfer(result.plans)
      renderTransferPlans(result.plans)
      await previewTransferPlans(result.plans, { fitCamera: true })
      return
    }
    trip.completeEmpty()
    renderTransferPlans([])
    await previewTransferPlans([], { fitCamera: true })
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
}`

const removeFunctions = new Set([
  'fetchJourneyEta',
  'rankDirectRoutesByEta',
  'sortableJourneyMinutes',
  'isReliableJourneyArrival',
  'rankTransferPlansByEta',
])
const file = ts.createSourceFile(mainPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
const edits = []
let replacedLoader = false
let removedEtaType = false
for (const statement of file.statements) {
  if (ts.isTypeAliasDeclaration(statement) && statement.name.text === 'JourneyEtaValue') {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: '' })
    removedEtaType = true
    continue
  }
  if (!ts.isFunctionDeclaration(statement) || !statement.name) continue
  if (statement.name.text === 'loadDirectRoutes') {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: `\n${loadDirectRoutes}\n` })
    replacedLoader = true
  } else if (removeFunctions.has(statement.name.text)) {
    edits.push({ start: statement.getFullStart(), end: statement.end, text: '' })
    removeFunctions.delete(statement.name.text)
  }
}
if (!replacedLoader) throw new Error('Missing loadDirectRoutes')
if (!removedEtaType) throw new Error('Missing JourneyEtaValue')
if (removeFunctions.size) throw new Error(`Missing functions: ${[...removeFunctions].join(', ')}`)
source = applyEdits(source, edits).replace(/\n{4,}/g, '\n\n\n')
fs.writeFileSync(mainPath, source)

const sizePath = 'web/map/main-size.test.ts'
let sizeSource = fs.readFileSync(sizePath, 'utf8')
const lineCount = source.split(/\r?\n/).length
sizeSource = sizeSource.replace(/const MAP_MAIN_LINE_LIMIT = \d+/, `const MAP_MAIN_LINE_LIMIT = ${lineCount}`)
fs.writeFileSync(sizePath, sizeSource)
console.log(`main.ts line limit: ${lineCount}`)
