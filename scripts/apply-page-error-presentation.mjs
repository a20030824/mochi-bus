import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/routes/bus.ts'
let source = readFileSync(path, 'utf8')

const uiImport = "import { appIcon, renderAmbiguousPage, renderErrorPage, renderETAPage, renderRoutePage, renderSetupPage } from '../ui'\n"
const presentationImport = "import { presentPageError, publicErrorMessage } from '../presentation/page-error'\n"
if (!source.includes(uiImport)) throw new Error('UI import anchor not found')
source = source.replace(uiImport, `${uiImport}${presentationImport}`)

const oldRenderPageError = `function renderPageError(c: Context<Env>, error: unknown) {
  const message = toPublicError(error)
  const isQueryError = error instanceof QueryValidationError || error instanceof QueryResolutionError
  const status = error instanceof QueryValidationError
    ? 400
    : error instanceof QueryResolutionError ? 404
      : error instanceof TDXServiceError && error.rateLimited ? 429 : 503
  const setupUrl = \`/setup?\${toBusSearchParams({ ...defaultBusQuery, stopName: defaultBusQuery.stopName }).toString()}\`
  const title = isQueryError ? '找不到這班公車' : '暫時無法取得公車資料'
  const actionsHTML = isQueryError
    ? \`<a href="\${escapeHTML(setupUrl)}">重新選擇路線與站牌</a>\`
    : '<a href="/">回到首頁</a><a href="/map">打開地圖</a>'
  return c.html(renderErrorPage({ title, message, actionsHTML, requestUrl: c.req.url }), status)
}`

const newRenderPageError = `function renderPageError(c: Context<Env>, error: unknown) {
  const setupUrl = \`/setup?\${toBusSearchParams({ ...defaultBusQuery, stopName: defaultBusQuery.stopName }).toString()}\`
  const presentation = presentPageError(error, setupUrl)
  const actionsHTML = presentation.actions
    .map(({ href, label }) => \`<a href="\${escapeHTML(href)}">\${escapeHTML(label)}</a>\`)
    .join('')
  return c.html(renderErrorPage({
    title: presentation.title,
    message: presentation.message,
    actionsHTML,
    requestUrl: c.req.url,
  }), presentation.status)
}`

if (!source.includes(oldRenderPageError)) throw new Error('renderPageError anchor not found')
source = source.replace(oldRenderPageError, newRenderPageError)

const oldPublicError = `function toPublicError(error: unknown): string {
  if (error instanceof QueryValidationError || error instanceof QueryResolutionError) return error.message
  if (error instanceof TDXServiceError) return tdxWarningMessages[tdxWarningFromError(error) ?? 'tdx-unavailable']
  return '暫時無法取得公車資料'
}`
const newPublicError = `function toPublicError(error: unknown): string {
  return publicErrorMessage(error)
}`
if (!source.includes(oldPublicError)) throw new Error('toPublicError anchor not found')
source = source.replace(oldPublicError, newPublicError)

writeFileSync(path, source)
