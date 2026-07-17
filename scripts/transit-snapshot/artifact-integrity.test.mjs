import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assertArtifactIntegrity, criticalArtifacts, sameArtifactManifest, sameMetrics } from './artifact-integrity.mjs'

const prefix = 'snapshots/v1/cities/Chiayi/'

function artifact(key, body = key) {
  const bytes = Buffer.from(body)
  return {
    key,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    contentType: 'application/json',
  }
}

describe('snapshot artifact integrity', () => {
  it('matches every expected metric and artifact field while rejecting duplicate keys', () => {
    const expected = [artifact(`${prefix}network.json`), artifact(`${prefix}shapes/P1.json`)]
    expect(sameMetrics({ routes: 3, patterns: 4, extra: 1 }, { routes: 3, patterns: 4 })).toBe(true)
    expect(sameMetrics({ routes: 2, patterns: 4 }, { routes: 3, patterns: 4 })).toBe(false)
    expect(sameArtifactManifest([...expected], expected)).toBe(true)
    expect(sameArtifactManifest([expected[0], expected[0]], expected)).toBe(false)
  })

  it('requires network, shape, schedule, and place artifact classes', () => {
    const complete = [
      artifact(`${prefix}network.json`),
      artifact(`${prefix}shapes/P1.json`),
      artifact(`${prefix}schedules/R1.json`),
      artifact(`${prefix}places/L1.json`),
    ]
    expect(criticalArtifacts(complete, prefix)).toHaveLength(4)
    expect(() => criticalArtifacts(complete.slice(0, 3), prefix)).toThrow(/critical artifact class/)
  })

  it('checks both byte length and SHA-256 after reading an object back', () => {
    const expected = artifact(`${prefix}network.json`, 'network-body')
    expect(() => assertArtifactIntegrity(expected, Buffer.from('network-body'))).not.toThrow()
    expect(() => assertArtifactIntegrity(expected, Buffer.from('network-b0dy'))).toThrow(/integrity mismatch/)
  })
})
