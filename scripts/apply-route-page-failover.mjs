import { readFileSync, writeFileSync } from 'node:fs'

const path = 'src/routes/bus.ts'
let source = readFileSync(path, 'utf8')

function replaceOnce(before, after, label) {
  const first = source.indexOf(before)
  if (first < 0) throw new Error(`Missing ${label}`)
  if (source.indexOf(before, first + before.length) >= 0) throw new Error(`Duplicate ${label}`)
  source = source.replace(before, after)
}

replaceOnce(
  "import { getSnapshotRoutePage } from '../application/snapshot-route-page'",
  "import { getRoutePageWithFallback } from '../application/route-page'",
  'snapshot application import',
)

replaceOnce(
  "import { getRoutePageDetail } from '../domain/route-page-detail'\n",
  '',
  'route detail import',
)

replaceOnce(
`  try {
    const env = tdxEnv(c)
    const resolved = await resolveBusQuery(env, query)
    const { detail } = await getRoutePageDetail(env, resolved)
    return c.html(embedRoutePageIdentity(renderRoutePage(resolved, detail, c.req.url), detail), 200, pageHeaders)
  } catch (error) {
    try {
      const fallback = await getSnapshotRoutePage(c.env, query)
      if (fallback) {
        return c.html(
          embedRoutePageIdentity(renderRoutePage(fallback.resolved, fallback.detail, c.req.url), fallback.detail),
          200,
          pageHeaders,
        )
      }
    } catch (fallbackError) {
      console.error('route_snapshot_fallback_failed', fallbackError)
    }
    return renderPageError(c, error)
  }`,
`  try {
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
  }`,
  'Route handler failover block',
)

if (source.includes('getSnapshotRoutePage')) throw new Error('Route handler still references snapshot orchestration')
if (source.includes('getRoutePageDetail')) throw new Error('Route handler still references route detail orchestration')

writeFileSync(path, source)
