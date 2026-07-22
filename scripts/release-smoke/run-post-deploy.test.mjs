import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  main,
  selectCatalogueRouteSample,
  validateCatalogueRouteContract,
} from './run-post-deploy.mjs'

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

  it('derives the fixed route-name sample from every current catalogue identity', () => {
    const catalogue = {
      routes: [
        { routeName: '0東', routeUid: 'TPE-FIRST' },
        { routeName: '307', routeUid: 'TPE307-B' },
        { routeName: '307', routeUid: 'TPE307-A' },
        { routeName: '307', routeUid: 'TPE307-A' },
      ],
    }
    expect(selectCatalogueRouteSample(catalogue, '307')).toEqual({
      routeName: '307',
      routeUids: ['TPE307-A', 'TPE307-B'],
    })
    expect(() => selectCatalogueRouteSample(catalogue, 'missing'))
      .toThrowError(expect.objectContaining({ code: 'route_sample_missing' }))
  })

  it('accepts a usable route variant when its UID intersects the catalogue sample', () => {
    const sample = { routeName: '307', routeUids: ['TPE307-A', 'TPE307-B'] }
    const validVariant = {
      variantKey: 'PATTERN-B',
      routeName: '307',
      routeUid: 'TPE307-B',
      stops: {
        features: [
          { properties: { stopUid: 'STOP-1' } },
          { properties: { stopUid: 'STOP-2' } },
        ],
      },
    }
    const detail = {
      schemaVersion: 1,
      city: 'Taipei',
      routeName: '307',
      source: 'snapshot',
      variants: [{ ...validVariant, routeUid: 'TPE-OTHER' }, validVariant],
    }
    expect(validateCatalogueRouteContract(detail, 'Taipei', sample)).toBe(validVariant)
    expect(() => validateCatalogueRouteContract({
      ...detail,
      variants: [{ ...validVariant, routeUid: 'TPE-OTHER' }],
    }, 'Taipei', sample)).toThrowError(expect.objectContaining({ code: 'route_contract_invalid' }))
  })

  it('uses route name without catalogue order or a hardcoded UID in production requests', () => {
    expect(source).toContain("const TAIPEI_ROUTE_SAMPLE = '307'")
    expect(source).toContain('selectCatalogueRouteSample(taipei, TAIPEI_ROUTE_SAMPLE)')
    expect(source).not.toContain('taipei.routes[0]')
    expect(source).not.toContain('TPE19108')
    expect(source).not.toMatch(/routeUid=\$\{encodeURIComponent\(route\./)
    expect(source).toContain("'route_http_failed'")
    expect(source).toContain("validateCatalogueRouteContract(detail, 'Taipei', route)")
  })
})
