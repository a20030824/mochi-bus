import type { RouteEtaResponse, RouteEtaState, RouteEtaStop } from '../../src/domain/route-page-detail'

type RouteEtaWarning = Extract<RouteEtaState, { kind: 'unavailable' }>['warning']

const ETA_TONES = new Set<RouteEtaStop['etaTone']>(['live', 'urgent', 'muted'])
const TDX_WARNINGS = new Set<RouteEtaWarning>(['tdx-rate-limit', 'tdx-quota', 'tdx-unavailable'])

export function parseRouteEtaResponse(value: unknown): RouteEtaResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.stops)) {
    throw new Error('Route ETA response has an invalid envelope')
  }

  return {
    schemaVersion: 1,
    eta: parseEtaState(value.eta),
    stops: value.stops.map(parseStop),
  }
}

function parseEtaState(value: unknown): RouteEtaState {
  if (!isRecord(value) || typeof value.kind !== 'string') {
    throw new Error('Route ETA response has an invalid state')
  }
  if (value.kind === 'realtime' || value.kind === 'empty') return { kind: value.kind }
  if (value.kind === 'unavailable'
    && typeof value.warning === 'string'
    && TDX_WARNINGS.has(value.warning as RouteEtaWarning)) {
    return { kind: 'unavailable', warning: value.warning as RouteEtaWarning }
  }
  throw new Error('Route ETA response has an invalid state')
}

function parseStop(value: unknown): RouteEtaStop {
  if (!isRecord(value)
    || typeof value.stopUid !== 'string'
    || !value.stopUid
    || typeof value.stopName !== 'string'
    || !value.stopName
    || typeof value.sequence !== 'number'
    || !Number.isFinite(value.sequence)
    || (typeof value.etaLabel !== 'string' && value.etaLabel !== null)
    || typeof value.etaTone !== 'string'
    || !ETA_TONES.has(value.etaTone as RouteEtaStop['etaTone'])) {
    throw new Error('Route ETA response has an invalid stop')
  }

  return {
    stopUid: value.stopUid,
    stopName: value.stopName,
    sequence: value.sequence,
    etaLabel: value.etaLabel,
    etaTone: value.etaTone as RouteEtaStop['etaTone'],
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
