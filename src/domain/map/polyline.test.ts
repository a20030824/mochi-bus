import { describe, expect, it } from 'vitest'
import { decodePolyline, polylineToGeoJSONCoordinates } from './polyline'

describe('TDX encoded polyline', () => {
  const encoded = '_p~iF~ps|U_ulLnnqC_mqNvxq`@'

  it('decodes latitude and longitude', () => {
    expect(decodePolyline(encoded)).toEqual([
      [38.5, -120.2],
      [40.7, -120.95],
      [43.252, -126.453],
    ])
  })

  it('outputs GeoJSON longitude-latitude order', () => {
    expect(polylineToGeoJSONCoordinates(encoded)[0]).toEqual([-120.2, 38.5])
  })

  it('rejects truncated data', () => {
    expect(() => decodePolyline('_')).toThrow('Invalid encoded polyline')
  })
})
