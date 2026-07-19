import { appendFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseWindowSummary } from './window-contract.mjs'

const DEFAULT_ROOT = join('.transit-snapshot', 'window-results')

export async function collectWindowSummaries(cities, root = DEFAULT_ROOT) {
  const summaries = []
  for (const city of cities) {
    try {
      summaries.push(parseWindowSummary(JSON.parse(await readFile(join(root, `${city}.json`), 'utf8'))))
    } catch {
      summaries.push(Object.freeze({
        schemaVersion: 2,
        city,
        windowId: 'unavailable',
        result: 'failed',
        activeVersion: null,
        previousVersion: null,
        lastSourceCheckAt: null,
        lastPublishedAt: null,
        failureClass: 'unknown',
        durableRecordWrite: 'failed',
        activeProbeResult: null,
        rollbackAvailable: null,
        probeFailureClass: null,
        diagnosticWarnings: [],
      }))
    }
  }
  return summaries
}

export function snapshotWindowMarkdown(summaries) {
  const lines = [
    '## Snapshot window outcomes',
    '',
    '| City | Window | Source | Result | Active | Probe | Rollback | Probe class | Warnings | Durable record |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summaries.map((item) => `| ${item.city} | ${item.windowId} | ${sourceResult(item)} | ${item.result} | ${item.activeVersion ?? '—'} | ${item.activeProbeResult ?? 'not_run'} | ${item.rollbackAvailable === null ? 'not_checked' : item.rollbackAvailable ? 'available' : 'degraded'} | ${item.probeFailureClass ?? '—'} | ${item.diagnosticWarnings.join(', ') || 'none'} | ${item.durableRecordWrite} |`),
    '',
    ...['published', 'unchanged', 'failed'].map((result) => {
      const cities = summaries.filter((item) => item.result === result).map((item) => item.city)
      return `- ${result}: ${cities.length ? cities.join(', ') : 'none'}`
    }),
    `- window-record-write-failed: ${summaries.filter((item) => item.durableRecordWrite === 'failed').map((item) => item.city).join(', ') || 'none'}`,
    `- unchanged-healthy: ${summaries.filter((item) => item.result === 'unchanged' && item.activeProbeResult === 'success').map((item) => item.city).join(', ') || 'none'}`,
    `- unchanged-rollback-degraded: ${summaries.filter((item) => item.result === 'unchanged' && item.activeProbeResult === 'degraded').map((item) => item.city).join(', ') || 'none'}`,
    `- active-probe-failed: ${summaries.filter((item) => item.activeProbeResult === 'error').map((item) => item.city).join(', ') || 'none'}`,
    '',
  ]
  return lines.join('\n')
}

async function main() {
  const cities = process.argv.slice(2)
  const summaries = await collectWindowSummaries(cities)
  const markdown = snapshotWindowMarkdown(summaries)
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown)
  console.log(JSON.stringify({
    message: 'snapshot_window_batch_completed',
    published: summaries.filter((item) => item.result === 'published').map((item) => item.city),
    unchanged: summaries.filter((item) => item.result === 'unchanged').map((item) => item.city),
    failed: summaries.filter((item) => item.result === 'failed').map((item) => item.city),
    windowRecordWriteFailed: summaries.filter((item) => item.durableRecordWrite === 'failed').map((item) => item.city),
    unchangedHealthy: summaries.filter((item) => item.result === 'unchanged' && item.activeProbeResult === 'success').map((item) => item.city),
    unchangedRollbackDegraded: summaries.filter((item) => item.result === 'unchanged' && item.activeProbeResult === 'degraded').map((item) => item.city),
    activeProbeFailed: summaries.filter((item) => item.activeProbeResult === 'error').map((item) => item.city),
  }))
}

function sourceResult(item) {
  if (item.result === 'unchanged') return 'unchanged'
  if (item.result === 'published') return 'changed'
  return item.lastSourceCheckAt ? 'checked' : 'not_checked'
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
