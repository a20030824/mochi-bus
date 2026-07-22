import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const rollbackUrl = new URL('./rollback.mjs', import.meta.url)
const rollbackPath = fileURLToPath(rollbackUrl)
const rollbackSource = readFileSync(rollbackUrl, 'utf8')
const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'))

describe('snapshot rollback CLI contract', () => {
  it('exposes a separate reconcile command without a force bypass', () => {
    expect(packageJson.scripts['snapshot:rollback']).toBe('node scripts/transit-snapshot/rollback.mjs')
    expect(packageJson.scripts['snapshot:reconcile']).toBe('node scripts/transit-snapshot/rollback.mjs reconcile')
    expect(rollbackSource).not.toContain('--force')
    expect(rollbackSource).toContain("args.some((arg) => arg.startsWith('--'))")
  })

  it('rejects flags before loading credentials or touching remote state', () => {
    const result = spawnSync(process.execPath, [rollbackPath, '--force'], { encoding: 'utf8' })
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(JSON.parse(result.stderr.trim())).toEqual({
      event: 'snapshot_authority_operation',
      operation: 'unknown',
      city: null,
      outcome: 'invalid_arguments',
      activeVersion: null,
      previousVersion: null,
      targetVersion: null,
    })
  })

  it('pins post-switch smoke to an exact route variant', () => {
    expect(rollbackSource).toContain('&routeUid=${encodeURIComponent(evidence.sample.routeUid)}')
    expect(rollbackSource).toContain('&patternId=${encodeURIComponent(evidence.sample.patternId)}')
  })

  it('does not print raw errors, stacks, responses, or command stderr', () => {
    expect(rollbackSource).not.toMatch(/console\.(?:error|log)\([^\n]*(?:error\.message|error\.stack|result\.stderr|response\.body)/)
    expect(rollbackSource).not.toContain('console.error(error)')
    expect(rollbackSource).toContain('safeOperationDiagnostic(error, operation, city)')
  })
})
