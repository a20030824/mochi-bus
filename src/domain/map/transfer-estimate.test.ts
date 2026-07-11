import { describe, expect, it } from 'vitest'
import { describeTransferEstimate, estimateTransfer, transferEstimateSortKey } from './transfer-estimate'

describe('estimateTransfer', () => {
  it('returns a total range only when both realtime arrivals leave a safe connection', () => {
    const estimate = estimateTransfer({
      firstStopCount: 3,
      secondStopCount: 4,
      walkMeters: 120,
      firstEtaMinutes: 2,
      secondEtaMinutes: 20,
    })

    expect(estimate.connectionStatus).toBe('likely')
    expect(estimate.totalMinutes).toEqual({ min: 24, max: 36 })
    expect(estimate.travelMinutes.min).toBeGreaterThan(10)
  })

  it('does not promise a total when the connection window is tight', () => {
    const estimate = estimateTransfer({
      firstStopCount: 3,
      secondStopCount: 4,
      walkMeters: 120,
      firstEtaMinutes: 2,
      secondEtaMinutes: 12,
    })

    expect(estimate.connectionStatus).toBe('tight')
    expect(estimate.totalMinutes).toBeNull()
  })

  it('marks the currently visible second bus as missed when it arrives too early', () => {
    const estimate = estimateTransfer({
      firstStopCount: 6,
      secondStopCount: 2,
      walkMeters: 300,
      firstEtaMinutes: 8,
      secondEtaMinutes: 4,
    })

    expect(estimate.connectionStatus).toBe('missed')
    expect(estimate.totalMinutes).toBeNull()
  })

  it('shows only a ride-and-walk range when realtime arrivals are incomplete', () => {
    const withoutWalk = estimateTransfer({
      firstStopCount: 2,
      secondStopCount: 3,
      walkMeters: 0,
      firstEtaMinutes: null,
      secondEtaMinutes: 10,
    })
    const withWalk = estimateTransfer({
      firstStopCount: 2,
      secondStopCount: 3,
      walkMeters: 300,
      firstEtaMinutes: null,
      secondEtaMinutes: 10,
    })

    expect(withWalk.connectionStatus).toBe('unknown')
    expect(withWalk.totalMinutes).toBeNull()
    expect(withWalk.travelMinutes.min).toBeGreaterThan(withoutWalk.travelMinutes.min)
    expect(withWalk.travelMinutes.max).toBeGreaterThan(withoutWalk.travelMinutes.max)
  })

  it('sorts likely connections before unknown, tight, and missed plans', () => {
    const input = { firstStopCount: 2, secondStopCount: 2, walkMeters: 0 }
    const likely = estimateTransfer({ ...input, firstEtaMinutes: 1, secondEtaMinutes: 15 })
    const unknown = estimateTransfer({ ...input, firstEtaMinutes: null, secondEtaMinutes: 15 })
    const tight = estimateTransfer({ ...input, firstEtaMinutes: 1, secondEtaMinutes: 7 })
    const missed = estimateTransfer({ ...input, firstEtaMinutes: 10, secondEtaMinutes: 1 })

    expect([likely, unknown, tight, missed].map(transferEstimateSortKey)).toEqual(
      [...[likely, unknown, tight, missed].map(transferEstimateSortKey)].sort((a, b) => a - b),
    )
  })

  it('describes ranges and unknown waiting time without fake precision', () => {
    const unknown = estimateTransfer({
      firstStopCount: 2,
      secondStopCount: 3,
      walkMeters: 180,
      firstEtaMinutes: null,
      secondEtaMinutes: null,
    })
    const presentation = describeTransferEstimate(unknown)

    expect(presentation.label).toMatch(/^車程＋步行 \d+–\d+ 分$/)
    expect(presentation.note).toContain('未含候車與路況')
    expect(`${presentation.label}${presentation.note}`).not.toContain('20 分')
  })
})
