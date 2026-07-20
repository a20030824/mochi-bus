import type { RoutePageIdentity, RoutePageIdentityStop } from '../../src/domain/route-page-identity'
import { ROUTE_IDENTITY_SCRIPT_ID } from '../../src/domain/route-page-identity'

const MAX_ROUTE_STOPS = 1_000
const MAX_STOP_UID_LENGTH = 100
const MAX_STOP_NAME_LENGTH = 160

export function readRoutePageIdentity(documentRoot: Document = document): RoutePageIdentity {
  const node = documentRoot.getElementById(ROUTE_IDENTITY_SCRIPT_ID)
  if (!(node instanceof HTMLScriptElement) || node.type !== 'application/json') {
    throw new Error('Route page identity island is missing')
  }

  let value: unknown
  try {
    value = JSON.parse(node.textContent ?? '')
  } catch {
    throw new Error('Route page identity island contains invalid JSON')
  }

  if (!isRecord(value)
    || value.schemaVersion !== 1
    || !Array.isArray(value.stops)
    || value.stops.length === 0
    || value.stops.length > MAX_ROUTE_STOPS) {
    throw new Error('Route page identity has an invalid envelope')
  }

  const stops = value.stops.map(parseIdentityStop)
  if (stops.filter((stop) => stop.selected).length !== 1) {
    throw new Error('Route page identity must contain exactly one selected stop')
  }
  for (let index = 1; index < stops.length; index += 1) {
    if (stops[index].sequence <= stops[index - 1].sequence) {
      throw new Error('Route page identity station order is invalid')
    }
  }

  return { schemaVersion: 1, stops }
}

function parseIdentityStop(value: unknown): RoutePageIdentityStop {
  if (!isRecord(value)
    || typeof value.stopUid !== 'string'
    || value.stopUid.length === 0
    || value.stopUid.length > MAX_STOP_UID_LENGTH
    || typeof value.stopName !== 'string'
    || value.stopName.length === 0
    || value.stopName.length > MAX_STOP_NAME_LENGTH
    || typeof value.sequence !== 'number'
    || !Number.isSafeInteger(value.sequence)
    || value.sequence < 0
    || typeof value.selected !== 'boolean') {
    throw new Error('Route page identity contains an invalid stop')
  }

  return {
    stopUid: value.stopUid,
    stopName: value.stopName,
    sequence: value.sequence,
    selected: value.selected,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
