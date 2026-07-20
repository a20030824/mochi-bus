import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/routes/bus.ts'
const source = readFileSync(path, 'utf8')
const before = `bus.get('/route', async (c) => {
  let query: BusQuery
  try {
    query = parseRequestQuery(c)
  } catch (error) {
    return renderPageError(c, error)
  }
  try {
    const page = await getRoutePageWithFallback({
      tdx: tdxEnv(c),
      snapshot: c.env,
    }, query)
    return c.html(
      embedRoutePageIdentity(renderRoutePage(page.resolved, page.detail, c.req.url), page.detail),
      200,
      pageHeaders,
    )
  } catch (error) {
    return renderPageError(c, error)
  }
})`
const after = `export type RoutePageHandlerDependencies = {
  getRoutePageWithFallback: typeof getRoutePageWithFallback
}

const defaultRoutePageHandlerDependencies: RoutePageHandlerDependencies = {
  getRoutePageWithFallback,
}

export function createRoutePageHandler(
  dependencies: RoutePageHandlerDependencies = defaultRoutePageHandlerDependencies,
) {
  return async (c: Context<Env>) => {
    let query: BusQuery
    try {
      query = parseRequestQuery(c)
    } catch (error) {
      return renderPageError(c, error)
    }
    try {
      const page = await dependencies.getRoutePageWithFallback({
        tdx: tdxEnv(c),
        snapshot: c.env,
      }, query)
      return c.html(
        embedRoutePageIdentity(renderRoutePage(page.resolved, page.detail, c.req.url), page.detail),
        200,
        pageHeaders,
      )
    } catch (error) {
      return renderPageError(c, error)
    }
  }
}

bus.get('/route', createRoutePageHandler())`

if (!source.includes(before)) {
  throw new Error('Expected /route handler block was not found')
}

writeFileSync(path, source.replace(before, after))
