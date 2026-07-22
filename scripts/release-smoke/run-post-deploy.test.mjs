import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { main } from './run-post-deploy.mjs'

const source = readFileSync(new URL('./run-post-deploy.mjs', import.meta.url), 'utf8')

describe('post-deploy smoke CLI adapter', () => {
  it('loads without running production traffic during import', () => {
    expect(main).toBeTypeOf('function')
    expect(source).toContain("if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)")
  })

  it('keeps failures bounded and does not print raw errors or response bodies', () => {
    expect(source).not.toMatch(/console\.error\([^\n]*(?:error\.message|error\.stack|response\.body|request\.url)/)
    expect(source).not.toContain('console.error(error)')
    expect(source).toContain('safeReleaseSmokeDiagnostic(error, expectedSha)')
  })

  it('uses a stable route name with catalogue-derived identities instead of order or a hardcoded UID', () => {
    expect(source).toContain("const TAIPEI_ROUTE_SAMPLE = '307'")
    expect(source).toContain('selectRepresentativeRoute(taipei, TAIPEI_ROUTE_SAMPLE)')
    expect(source).not.toContain('taipei.routes[0]')
    expect(source).not.toContain('TPE19108')
    expect(source).not.toMatch(/routeUid=\$\{encodeURIComponent\(route\./)
    expect(source).toContain("'route_http_failed'")
    expect(source).toContain("validateRouteContract(detail, 'Taipei', route)")
  })
})
