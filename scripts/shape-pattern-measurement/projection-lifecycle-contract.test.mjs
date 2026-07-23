import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { MATCHER_SOURCE } from './constants.mjs'
import { loadMatcherModule } from './instrument-loader.mjs'

const roots = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

async function sha256() { return createHash('sha256').update(await readFile(MATCHER_SOURCE)).digest('hex') }
async function generatedRoot() { const root = await mkdtemp(join(tmpdir(), 'projection-lifecycle-')); roots.push(root); return root }

const shape = { shapeId: 's1', routeUid: 'R1', direction: 0, coordinates: [[121, 25], [121.01, 25.01]] }
const pattern = (stops) => ({ patternId: 'p1', routeUid: 'R1', direction: 0, stops })

async function eventsFor(patterns, shapes = [shape]) {
  const events = []
  const loaded = await loadMatcherModule({ instrumented: true, expectedMatcherSha256: await sha256(), generatedRunDir: await generatedRoot(), onMeasurement: (event, payload) => events.push({ event, payload }) })
  try { loaded.invoke(patterns, shapes) } finally { await loaded.dispose() }
  return events
}

function projectionStatuses(events) { return events.filter((entry) => entry.event === 'projection-end').map((entry) => entry.payload.status) }

describe('projection and orientation lifecycle', () => {
  it('does not fabricate projection events for a pattern rejected before pair scoring', async () => {
    const events = await eventsFor([pattern([])])
    expect(projectionStatuses(events)).toEqual([])
  })

  it('emits exact threshold-rejected status for final distance rejection', async () => {
    const events = await eventsFor([pattern([{ coordinate: [130, 35] }, { coordinate: [130.1, 35.1] }])])
    expect(projectionStatuses(events)).toEqual(['threshold-rejected', 'threshold-rejected'])
  })

  it('emits directional success/frontier outcomes with reconciled orientation events', async () => {
    const events = await eventsFor([pattern([{ coordinate: [121, 25] }, { coordinate: [121.01, 25.01] }])])
    const projectionEnds = events.filter((entry) => entry.event === 'projection-end')
    expect(projectionEnds.map((entry) => [entry.payload.orientation, entry.payload.status])).toEqual([
      ['forward', 'success'],
      ['reverse', 'frontier-empty'],
    ])
    const orientationStarts = events.filter((entry) => entry.event === 'orientation-start')
    const orientationEnds = events.filter((entry) => entry.event === 'orientation-end')
    expect(orientationStarts.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
    expect(orientationEnds.map((entry) => entry.payload.orientation).sort()).toEqual(['forward', 'reverse'])
    expect(orientationEnds.every((entry) => Number.isFinite(entry.payload.elapsedMs) && entry.payload.elapsedMs >= 0)).toBe(true)
    const projectionStarts = events.filter((entry) => entry.event === 'projection-start')
    expect(projectionStarts).toHaveLength(projectionEnds.length)
  })

  it('classifies a middle-layer frontier exhaustion as frontier-empty', async () => {
    const events = await eventsFor([pattern([
      { coordinate: [121.01, 25.01] },
      { coordinate: [121, 25] },
      { coordinate: [121.01, 25.01] },
    ])])
    expect(projectionStatuses(events)).toEqual(['frontier-empty', 'frontier-empty'])
  })
})
