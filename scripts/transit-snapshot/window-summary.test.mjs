import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectWindowSummaries, snapshotWindowMarkdown } from './window-summary.mjs'

const successfulSummary = {
  schemaVersion: 1,
  city: 'Taipei',
  windowId: 'v1:Taipei:2026-07-20:0317',
  result: 'unchanged',
  activeVersion: 'snapshot-safe-1',
  previousVersion: 'snapshot-safe-0',
  lastSourceCheckAt: '2026-07-19T19:22:00.000Z',
  lastPublishedAt: '2026-07-13T19:30:00.000Z',
  failureClass: 'none',
  durableRecordWrite: 'success',
}

describe('snapshot window workflow summary', () => {
  it('keeps a successful city when another city has no result file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mochi-window-summary-'))
    await writeFile(join(root, 'Taipei.json'), JSON.stringify(successfulSummary))

    const summaries = await collectWindowSummaries(['Taipei', 'NewTaipei'], root)

    expect(summaries).toHaveLength(2)
    expect(summaries[0]).toMatchObject({ city: 'Taipei', result: 'unchanged', durableRecordWrite: 'success' })
    expect(summaries[1]).toMatchObject({ city: 'NewTaipei', result: 'failed', durableRecordWrite: 'failed' })
    expect(snapshotWindowMarkdown(summaries)).toContain('- unchanged: Taipei')
    expect(snapshotWindowMarkdown(summaries)).toContain('- failed: NewTaipei')
  })

  it('renders only the strict summary contract', () => {
    const markdown = snapshotWindowMarkdown([successfulSummary])

    expect(markdown).toContain('| Taipei | v1:Taipei:2026-07-20:0317 | unchanged |')
    expect(markdown).toContain('- window-record-write-failed: none')
    expect(markdown).not.toMatch(/authorization|client[_ -]?secret|access[_ -]?token|https?:\/\//i)
  })
})
