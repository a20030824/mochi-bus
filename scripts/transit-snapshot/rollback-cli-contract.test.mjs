import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const rollbackSource = readFileSync(new URL('./rollback.mjs', import.meta.url), 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('snapshot rollback CLI contract', () => {
  it('exposes a separate reconcile command without a force bypass', () => {
    expect(packageJson.scripts['snapshot:rollback']).toBe('node scripts/transit-snapshot/rollback.mjs')
    expect(packageJson.scripts['snapshot:reconcile']).toBe('node scripts/transit-snapshot/rollback.mjs reconcile')
    expect(rollbackSource).not.toContain('--force')
    expect(rollbackSource).toContain("args.some((arg) => arg.startsWith('--'))")
  })

  it('does not print raw errors, stacks, responses, or command stderr', () => {
    expect(rollbackSource).not.toMatch(/console\.(?:error|log)\([^\n]*(?:error\.message|error\.stack|result\.stderr|response\.body)/)
    expect(rollbackSource).not.toContain('console.error(error)')
    expect(rollbackSource).toContain('safeOperationDiagnostic(error, operation, city)')
  })
})
