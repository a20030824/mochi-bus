import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { executeMatcher, instrumentSource } from './instrument-loader.mjs'

const matcherPath = 'src/domain/map/shape-pattern-matcher.ts'
const matcherSource = await readFile(matcherPath, 'utf8')
const matcherSha256 = createHash('sha256').update(matcherSource).digest('hex')
const patterns = [{ patternId: 'P', routeUid: 'R', subRouteUid: 'S', direction: 0, stops: [
  { stopUid: 'A', coordinate: [121, 25] }, { stopUid: 'B', coordinate: [121.001, 25] },
] }]
const shapes = [{ shapeId: 'G', routeUid: 'R', subRouteUid: 'S', direction: 0, coordinates: [[121, 25], [121.001, 25]] }]

describe('matcher instrumentation loader', () => {
  it('fails closed on source hash mismatch and anchor mismatch', async () => {
    const generatedDir = await mkdtemp(join(tmpdir(), 'matcher-generated-'))
    try {
      await expect(executeMatcher({ patterns, shapes, instrumented: true,
        expectedMatcherSha256: '0'.repeat(64), generatedDir })).rejects.toMatchObject({ code: 'UNSUPPORTED_MATCHER_REVISION' })
      expect(() => instrumentSource('export function unrelated() {}')).toThrow(/anchor mismatch/)
    } finally {
      await rm(generatedDir, { recursive: true, force: true })
    }
  })

  it('keeps instrumented and uninstrumented results deep-equal and removes temporary source', async () => {
    const generatedDir = await mkdtemp(join(tmpdir(), 'matcher-generated-'))
    const events = []
    try {
      const plain = await executeMatcher({ patterns, shapes, generatedDir })
      const instrumented = await executeMatcher({ patterns, shapes, instrumented: true,
        expectedMatcherSha256: matcherSha256, generatedDir, onMeasurement: (event, payload) => events.push([event, payload]) })
      expect(instrumented.result).toEqual(plain.result)
      expect(events.some(([event]) => event === 'pair-end')).toBe(true)
      expect(events.some(([event]) => event === 'projection-layer')).toBe(true)
      expect(await readdir(generatedDir)).toEqual([])
    } finally {
      await rm(generatedDir, { recursive: true, force: true })
    }
  })

  it('contains callback failures and still cleans generated source', async () => {
    const generatedDir = await mkdtemp(join(tmpdir(), 'matcher-generated-'))
    try {
      await expect(executeMatcher({ patterns, shapes, instrumented: true,
        expectedMatcherSha256: matcherSha256, generatedDir,
        onMeasurement: () => { throw new Error('collector failed') },
      })).resolves.toMatchObject({ result: { matches: expect.any(Array) } })
      expect(await readdir(generatedDir)).toEqual([])
      expect(await readFile(matcherPath, 'utf8')).toBe(matcherSource)
    } finally {
      await rm(generatedDir, { recursive: true, force: true })
    }
  })
})
