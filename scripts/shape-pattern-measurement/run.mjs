#!/usr/bin/env node
import { execFile } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { buildCandidatePartitions } from './build-candidates.mjs'
import { helpText, parseCli } from './cli.mjs'
import { createMeasurementReport, writeMeasurementReport } from './report.mjs'
import { fetchRawBundle, replayRawBundle, safeErrorRecord } from './tdx-source.mjs'
import { stableStringify } from './util.mjs'

const execFileAsync = promisify(execFile)

export async function main(argv = process.argv.slice(2)) {
  const options = await parseCli(argv)
  if (options.help) {
    process.stdout.write(helpText)
    return
  }
  try {
    const source = options.replay
      ? await replayRawBundle({ rawDir: options.rawDir })
      : await fetchRawBundle({
          cities: options.cities,
          includeIntercity: options.includeIntercity,
          rawDir: options.rawDir,
          concurrency: options.fetchConcurrency,
        })
    const candidateBundle = buildCandidatePartitions(source.bundle)
    const repositoryMainSha = await resolveRepositoryMainSha()
    const report = await createMeasurementReport({
      candidateBundle,
      rawManifest: source.manifest,
      options,
      repositoryMainSha,
    })
    await writeMeasurementReport(report, options.reportDir)
    process.stdout.write(`${stableStringify({
      phase: 'complete',
      mode: report.metadata.mode,
      partitionCount: report.partitions.length,
      pairCount: report.pairs.length,
      reportDir: options.reportDir,
      deterministicContentHash: report.metadata.deterministicContentHash,
    })}\n`)
  } finally {
    await rm(options.generatedDir, { recursive: true, force: true })
  }
}

async function resolveRepositoryMainSha() {
  if (/^[a-f0-9]{40}$/i.test(process.env.GITHUB_SHA ?? '')) return process.env.GITHUB_SHA
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', 'origin/main'])
    return stdout.trim()
  } catch {
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'])
      return stdout.trim()
    } catch {
      return 'unknown'
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${stableStringify({ phase: 'failed', ...safeErrorRecord(error) })}\n`)
    process.exitCode = 1
  })
}
