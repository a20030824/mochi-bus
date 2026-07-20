import fs from 'node:fs'

const path = 'src/routes/bus.ts'
let source = fs.readFileSync(path, 'utf8')

const replacements = [
  [
    "import { TDX_ACCESS_TOKEN_REJECTED_CODE, TDX_ACCESS_TOKEN_REJECTED_MESSAGE } from '../domain/tdx-api-error'\n",
    '',
  ],
  [
    "  isRejectedUserTdxToken,\n",
    '',
  ],
  [
    "import { presentPageError, publicErrorMessage } from '../presentation/page-error'\n",
    "import { presentBusApiError } from '../presentation/api-error'\nimport { presentPageError, publicErrorMessage } from '../presentation/page-error'\n",
  ],
  [
    "  ApiInputError,\n  apiInputErrorBody,\n",
    '',
  ],
  [
    `function jsonError(c: Context<Env>, error: unknown) {\n  if (error instanceof ApiInputError) {\n    return c.json(apiInputErrorBody(error), error.status, noStoreHeaders)\n  }\n  if (isRejectedUserTdxToken(error, c.req.header('Authorization'))) {\n    return c.json({\n      code: TDX_ACCESS_TOKEN_REJECTED_CODE,\n      error: TDX_ACCESS_TOKEN_REJECTED_MESSAGE,\n    }, 401, noStoreHeaders)\n  }\n  if (!(error instanceof QueryValidationError || error instanceof QueryResolutionError)) {\n    console.error('bus_api_failed', error)\n  }\n  const status = error instanceof QueryValidationError\n    ? 400\n    : error instanceof QueryResolutionError ? 404\n      : error instanceof TDXServiceError && error.rateLimited ? 429 : 502\n  return c.json({ error: toPublicError(error) }, status, noStoreHeaders)\n}\n`,
    `function jsonError(c: Context<Env>, error: unknown) {\n  const presentation = presentBusApiError(error, c.req.header('Authorization'))\n  if (presentation.shouldLog) console.error('bus_api_failed', error)\n  return c.json(presentation.body, presentation.status, noStoreHeaders)\n}\n`,
  ],
]

for (const [before, after] of replacements) {
  if (!source.includes(before)) {
    throw new Error(`Expected bus.ts fragment was not found:\n${before}`)
  }
  source = source.replace(before, after)
}

fs.writeFileSync(path, source)
