import type { RouteEtaResponse, RouteEtaState, RouteEtaStop } from '../../src/domain/route-page-detail'
import {
  hasStrictlyIncreasingRouteSequence,
  isRouteRecord,
  parseRouteStationBase,
  parseRouteStationEnvelope,
} from './station-contract'

type RouteEtaWarning = Extract<RouteEtaState, { kind: 'unavailable' }>['warning']

const ETA_TONES = new Set<RouteEtaStop['etaTone']>(['live', 'urgent', 'muted'])
const TDX_WARNINGS = new Set<RouteEtaWarning>(['tdx-rate-limit', 'tdx-quota', 'tdx-unavailable'])
const MAX_ETA_LABEL_LENGTH = 64

export class RouteContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteContractError'
  }
}

export function parseRouteEtaResponse(value: unknown): RouteEtaResponse {
  const envelope = parseRouteStationEnvelope(value)
  if (!envelope) {
    throw new RouteContractError('Route ETA response has an invalid envelope')
  }

  const stops = envelope.stops.map(parseStop)
  if (!hasStrictlyIncreasingRouteSequence(stops)) {
    throw new RouteContractError('Route ETA response has an invalid station order')
  }

  return {
    schemaVersion: 1,
    eta: parseEtaState(envelope.record.eta),
    stops,
  }
}

function parseEtaState(value: unknown): RouteEtaState {
  if (!isRouteRecord(value) || typeof value.kind !== 'string') {
    throw new RouteContractError('Route ETA response has an invalid state')
  }
  if (value.kind === 'realtime' || value.kind === 'empty') return { kind: value.kind }
  if (value.kind === 'unavailable'
    && typeof value.warning === 'string'
    && TDX_WARNINGS.has(value.warning as RouteEtaWarning)) {
    return { kind: 'unavailable', warning: value.warning as RouteEtaWarning }
  }
  throw new RouteContractError('Route ETA response has an invalid state')
}

function parseStop(value: unknown): RouteEtaStop {
  const base = parseRouteStationBase(value)
  if (!base
    || !isRouteRecord(value)
    || (typeof value.etaLabel !== 'string' && value.etaLabel !== null)
    || (typeof value.etaLabel === 'string' && value.etaLabel.length > MAX_ETA_LABEL_LENGTH)
    || typeof value.etaTone !== 'string'
    || !ETA_TONES.has(value.etaTone as RouteEtaStop['etaTone'])) {
    throw new RouteContractError('Route ETA response has an invalid stop')
  }

  return {
    ...base,
    etaLabel: value.etaLabel,
    etaTone: value.etaTone as RouteEtaStop['etaTone'],
  }
}
