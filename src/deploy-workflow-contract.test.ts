/// <reference types="vite/client" />
import { describe, expect, it } from 'vitest'
import workflowSource from '../.github/workflows/deploy.yml?raw'

function stepPosition(name: string): number {
  const index = workflowSource.indexOf(`      - name: ${name}`)
  expect(index, `missing workflow step: ${name}`).toBeGreaterThanOrEqual(0)
  return index
}

describe('Deploy workflow post-deploy smoke contract', () => {
  it('runs exact-release HTTP/assets/browser smoke only after Worker deployment', () => {
    const deploy = stepPosition('Deploy Worker')
    const install = stepPosition('Install Chromium for post-deploy smoke')
    const smoke = stepPosition('Run true post-deploy release smoke')
    const upload = stepPosition('Upload post-deploy smoke evidence')

    expect(deploy).toBeLessThan(install)
    expect(install).toBeLessThan(smoke)
    expect(smoke).toBeLessThan(upload)
    expect(workflowSource).toContain('run: npm run release:smoke')
    expect(workflowSource).toContain('EXPECTED_RELEASE_SHA: ${{ github.sha }}')
    expect(workflowSource).toContain('RELEASE_SMOKE_ORIGIN: https://bus.moc96336.com')
    expect(workflowSource).toContain('release-smoke-report.json')
  })

  it('does not disguise pre-deploy checks or automatic rollback as post-deploy evidence', () => {
    const verify = stepPosition('Verify release candidate')
    const deploy = stepPosition('Deploy Worker')
    const smoke = stepPosition('Run true post-deploy release smoke')

    expect(verify).toBeLessThan(deploy)
    expect(deploy).toBeLessThan(smoke)
    expect(workflowSource).not.toMatch(/rollback|versions deploy|deployments rollback/i)
  })
})
