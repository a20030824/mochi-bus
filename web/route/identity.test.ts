import { describe, expect, it } from 'vitest'
import { parseRoutePageIdentity, RouteIdentityError } from './identity'

const valid = {
  schemaVersion: 1,
  stops: [
    { stopUid: 'TPE100', stopName: '板橋公車站', sequence: 1, selected: false },
    { stopUid: 'TPE213044', stopName: '捷運西門站', sequence: 2, selected: true },
  ],
}

describe('parseRoutePageIdentity', () => {
  it('accepts one ordered selected station identity', () => {
    expect(parseRoutePageIdentity(valid)).toEqual(valid)
  })

  it('accepts the same canonical station limits as the ETA contract', () => {
    const value = {
      ...valid,
      stops: [
        {
          ...valid.stops[0],
          stopUid: 'u'.repeat(128),
          stopName: '站'.repeat(256),
        },
        { ...valid.stops[1], sequence: Number.MAX_SAFE_INTEGER },
      ],
    }
    expect(parseRoutePageIdentity(value)).toEqual(value)
  })

  it.each([
    null,
    { ...valid, schemaVersion: 2 },
    { ...valid, stops: [] },
    { ...valid, stops: valid.stops.map((stop) => ({ ...stop, selected: false })) },
    { ...valid, stops: valid.stops.map((stop) => ({ ...stop, selected: true })) },
    { ...valid, stops: [valid.stops[1], valid.stops[0]] },
    { ...valid, stops: [{ ...valid.stops[0], sequence: 1.5 }, valid.stops[1]] },
    { ...valid, stops: [{ ...valid.stops[0], sequence: Number.MAX_SAFE_INTEGER + 1 }, valid.stops[1]] },
    { ...valid, stops: [{ ...valid.stops[0], stopUid: '' }, valid.stops[1]] },
    { ...valid, stops: [{ ...valid.stops[0], stopUid: 'u'.repeat(129) }, valid.stops[1]] },
    { ...valid, stops: [{ ...valid.stops[0], stopName: '站'.repeat(257) }, valid.stops[1]] },
  ])('rejects malformed or ambiguous identity %#', (value) => {
    expect(() => parseRoutePageIdentity(value)).toThrow(RouteIdentityError)
  })
})
