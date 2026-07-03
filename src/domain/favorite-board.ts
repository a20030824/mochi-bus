import type { ResolvedBusQuery } from './bus-query'

export type FavoriteBus = ResolvedBusQuery

export type FavoriteBoard = {
  version: 2
  id: string
  title: string
  buses: FavoriteBus[]
  createdAt: string
  updatedAt: string
}
