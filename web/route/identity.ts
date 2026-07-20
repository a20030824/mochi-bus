import type { RoutePageIdentity, RoutePageIdentityStop } from '../../src/domain/route-page-identity'
import { ROUTE_IDENTITY_SCRIPT_ID } from '../../src/domain/route-page-identity'
import {
  hasStrictlyIncreasingRouteSequence,
  isRouteRecord,
  parseRouteStationBase,
  parseRouteStationEnvelope,
} from './station-contract'

export class RouteIdentityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RouteIdentityError'
  }
}

export function readRoutePageIdentity(documentRoot: Document = document): RoutePageIdentity {
  const node = documentRoot.getElementById(ROUTE_IDENTITY_SCRIPT_ID)
  if (!(node instanceof HTMLScriptElement) || node.type !== 'application/json') {
    throw new RouteIdentityError('Route page identity island is missing')
  }

  let value: unknown
  try {
    value = JSON.parse(node.textContent ?? '')
  } catch {
    throw new RouteIdentityError('Route page identity island contains invalid JSON')
  }

  return parseRoutePageIdentity(value)
}

export function parseRoutePageIdentity(value: unknown): RoutePageIdentity {
  const envelope = parseRouteStationEnvelope(value)
  if (!envelope) {
    throw new RouteIdentityError('Route page identity has an invalid envelope')
  }

  const stops = envelope.stops.map(parseIdentityStop)
  if (stops.filter((stop) => stop.selected).length !== 1) {
    throw new RouteIdentityError('Route page identity must contain exactly one selected stop')
  }
  if (!hasStrictlyIncreasingRouteSequence(stops)) {
    throw new RouteIdentityError('Route page identity station order is invalid')
  }

  return { schemaVersion: 1, stops }
}

function parseIdentityStop(value: unknown): RoutePageIdentityStop {
  const base = parseRouteStationBase(value)
  if (!base || !isRouteRecord(value) || typeof value.selected !== 'boolean') {
    throw new RouteIdentityError('Route page identity contains an invalid stop')
  }

  return { ...base, selected: value.selected }
}
