import type { Direction } from '../bus-query'

export type Position = {
  latitude: number
  longitude: number
}

export type RouteMapVariant = {
  variantKey: string
  routeName: string
  routeUid: string
  subRouteUid?: string
  direction: Direction
  label: string
  subRouteName: string
  shape: {
    type: 'Feature'
    properties: { routeUid: string; direction: Direction }
    geometry: { type: 'LineString'; coordinates: Array<[number, number]> }
  }
  stops: {
    type: 'FeatureCollection'
    features: Array<{
      type: 'Feature'
      properties: { stopUid: string; stopName: string; sequence: number }
      geometry: { type: 'Point'; coordinates: [number, number] }
    }>
  }
  updatedAt: string | null
}
