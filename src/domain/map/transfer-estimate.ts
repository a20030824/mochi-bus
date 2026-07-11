export type MinuteRange = {
  min: number
  max: number
}

export type TransferConnectionStatus = 'likely' | 'tight' | 'missed' | 'unknown'

export type TransferEstimate = {
  travelMinutes: MinuteRange
  totalMinutes: MinuteRange | null
  connectionStatus: TransferConnectionStatus
}

type TransferEstimateInput = {
  firstStopCount: number
  secondStopCount: number
  walkMeters: number
  firstEtaMinutes: number | null
  secondEtaMinutes: number | null
}

const MIN_RIDE_MINUTES_PER_STOP = 1.5
const MAX_RIDE_MINUTES_PER_STOP = 3.5
const FAST_WALK_METERS_PER_MINUTE = 90
const SLOW_WALK_METERS_PER_MINUTE = 60
const ETA_UNCERTAINTY_MINUTES = 2
const SAFE_CONNECTION_BUFFER_MINUTES = 2

export function estimateTransfer(input: TransferEstimateInput): TransferEstimate {
  const firstRide = rideRange(input.firstStopCount)
  const secondRide = rideRange(input.secondStopCount)
  const walk = walkRange(input.walkMeters)
  const travelMinutes = addRanges(firstRide, secondRide, walk)
  const firstEta = validEta(input.firstEtaMinutes)
  const secondEta = validEta(input.secondEtaMinutes)

  if (firstEta === null || secondEta === null) {
    return { travelMinutes, totalMinutes: null, connectionStatus: 'unknown' }
  }

  const arrivalAtTransfer = addRanges({ min: firstEta, max: firstEta }, firstRide, walk)
  const secondArrival = {
    min: Math.max(0, secondEta - ETA_UNCERTAINTY_MINUTES),
    max: secondEta + ETA_UNCERTAINTY_MINUTES,
  }

  if (secondArrival.min >= arrivalAtTransfer.max + SAFE_CONNECTION_BUFFER_MINUTES) {
    return {
      travelMinutes,
      totalMinutes: addRanges(secondArrival, secondRide),
      connectionStatus: 'likely',
    }
  }

  return {
    travelMinutes,
    totalMinutes: null,
    connectionStatus: secondArrival.max >= arrivalAtTransfer.min ? 'tight' : 'missed',
  }
}

export function transferEstimateSortKey(estimate: TransferEstimate): number {
  if (estimate.totalMinutes) return estimate.totalMinutes.max
  const statusPenalty = estimate.connectionStatus === 'unknown' ? 10_000
    : estimate.connectionStatus === 'tight' ? 20_000
      : 30_000
  return statusPenalty + estimate.travelMinutes.max
}

export function describeTransferEstimate(estimate: TransferEstimate): { label: string; note: string } {
  if (estimate.totalMinutes) {
    return {
      label: `約 ${estimate.totalMinutes.min}–${estimate.totalMinutes.max} 分`,
      note: '依即時到站、站數與步行估算；仍可能受路況影響',
    }
  }
  if (estimate.connectionStatus === 'tight') {
    return {
      label: '這班銜接偏趕',
      note: '目前班次銜接不確定，未推測下一班候車時間',
    }
  }
  if (estimate.connectionStatus === 'missed') {
    return {
      label: '目前班次可能接不上',
      note: '目前班次銜接不確定，未推測下一班候車時間',
    }
  }
  return {
    label: `車程＋步行 ${estimate.travelMinutes.min}–${estimate.travelMinutes.max} 分`,
    note: '車程與步行粗估，未含候車與路況',
  }
}

function validEta(value: number | null): number | null {
  return value !== null && Number.isFinite(value) && value >= 0 ? value : null
}

function rideRange(stopCount: number): MinuteRange {
  const stops = Math.max(0, Math.floor(stopCount))
  return {
    min: Math.ceil(stops * MIN_RIDE_MINUTES_PER_STOP),
    max: Math.ceil(stops * MAX_RIDE_MINUTES_PER_STOP),
  }
}

function walkRange(walkMeters: number): MinuteRange {
  const meters = Math.max(0, walkMeters)
  if (meters === 0) return { min: 0, max: 0 }
  return {
    min: Math.max(1, Math.ceil(meters / FAST_WALK_METERS_PER_MINUTE)),
    max: Math.max(1, Math.ceil(meters / SLOW_WALK_METERS_PER_MINUTE)),
  }
}

function addRanges(...ranges: MinuteRange[]): MinuteRange {
  return ranges.reduce((total, range) => ({
    min: total.min + range.min,
    max: total.max + range.max,
  }), { min: 0, max: 0 })
}
