import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const readme = await readFile('scripts/shape-pattern-measurement/README.md', 'utf8')

describe('measurement README operability', () => {
  it('documents the complete live-fetch and two-mode offline replay workflow', () => {
    for (const required of [
      'TDX_CLIENT_ID', 'TDX_CLIENT_SECRET',
      '--cities Taipei,NewTaipei,Taoyuan,Keelung,Taichung,Tainan,Kaohsiung,Chiayi,MiaoliCounty',
      '--include-intercity', '--replay', '--warmup', '--iterations',
      '--instrumented', '--expected-matcher-sha256',
      'sha256sum src/domain/map/shape-pattern-matcher.ts',
      'completion.json', 'deterministicContentHash', 'bundleContentHash',
      'orphan', 'git status --short',
    ]) expect(readme).toContain(required)
  })

  it('distinguishes the Git blob SHA-1 pin from the caller-supplied file SHA-256', () => {
    expect(readme).toMatch(/Git blob SHA-1/i)
    expect(readme).toMatch(/file SHA-256/i)
    expect(readme).toContain('fc67cdecd785e89b9b08937edab156ade430198b')
  })

  it('keeps the production gate closed after harness verification', () => {
    expect(readme).toContain('C. Temporarily not ready for production integration.')
    expect(readme).toMatch(/Production PR 2 remains blocked/i)
    expect(readme).toMatch(/sanitized fixture.*must not/i)
  })
})
