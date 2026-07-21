import type { ResolvedBusQuery } from '../../domain/bus-query'
import type { TDXWarning } from '../../domain/tdx-warning'

const STALE_AFTER_MS = 3 * 60 * 1000

export type LocalizedName = {
  Zh_tw?: string
  En?: string
}

export type BusETAItem = {
  RouteUID?: string
  RouteName?: LocalizedName
  SubRouteUID?: string
  StopUID?: string
  StopName?: LocalizedName
  Direction?: number
  EstimateTime?: number | null
  StopStatus?: number
  DataTime?: string
  SrcUpdateTime?: string
  SrcTransTime?: string
  UpdateTime?: string
}

export type ETAResult = {
  routeName: string
  stopName: string
  stopUid: string
  direction: number
  estimateSeconds: number | null
  minutes: number | null
  label: string
  stopStatus: number
  statusLabel: string
  dataTime: string | null
  fetchedAt: string
  stale: boolean
  // 即時 GPS 沒有預估時間時，會退回查時刻表；source 讓前端知道這是不是真的即時資料。
  source: 'realtime' | 'schedule' | 'none'
  warning?: TDXWarning
}

export function toETAResult(item: BusETAItem, query: ResolvedBusQuery, now = new Date()): ETAResult {
  const estimateSeconds = typeof item.EstimateTime === 'number'
    ? Math.max(0, item.EstimateTime)
    : null
  const minutes = estimateSeconds === null ? null : Math.ceil(estimateSeconds / 60)
  const stopStatus = item.StopStatus ?? 0
  const dataTime = item.DataTime ?? item.SrcUpdateTime ?? item.SrcTransTime ?? item.UpdateTime ?? null
  const dataTimestamp = dataTime ? new Date(dataTime).getTime() : Number.NaN

  return {
    routeName: query.routeName,
    stopName: item.StopName?.Zh_tw ?? query.stopName,
    stopUid: item.StopUID ?? query.stopUid,
    direction: item.Direction ?? query.direction,
    estimateSeconds,
    minutes,
    label: formatETALabel(minutes, stopStatus),
    stopStatus,
    statusLabel: estimateSeconds === null ? formatStopStatus(stopStatus) : '正常',
    dataTime,
    fetchedAt: now.toISOString(),
    stale: Number.isFinite(dataTimestamp) && now.getTime() - dataTimestamp > STALE_AFTER_MS,
    source: estimateSeconds === null ? 'none' : 'realtime',
  }
}

export function formatETALabel(minutes: number | null, stopStatus: number): string {
  if (minutes !== null) return minutes <= 1 ? '即將進站' : `${minutes} 分`
  return formatStopStatus(stopStatus)
}

export function formatStopStatus(status: number): string {
  return ({
    0: '暫無預估時間',
    1: '尚未發車',
    2: '交管不停靠',
    3: '末班車已過',
    4: '今日未營運',
  } as Record<number, string>)[status] ?? '暫無資料'
}
