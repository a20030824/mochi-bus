export type MapFeature = 'network' | 'trip'

type FeatureState = Partial<Record<MapFeature, true>>

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

const STORAGE_KEY = 'mochi.map.used-features.v1'

export function createMapFeatureDiscovery(storage: StorageLike | undefined) {
  const usedInSession = new Set<MapFeature>()

  const read = (): FeatureState => {
    try {
      const raw = storage?.getItem(STORAGE_KEY)
      if (!raw) return {}
      const value = JSON.parse(raw) as unknown
      if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
      const record = value as Record<string, unknown>
      return {
        ...(record.network === true ? { network: true as const } : {}),
        ...(record.trip === true ? { trip: true as const } : {}),
      }
    } catch {
      return {}
    }
  }

  return {
    hasUsed(feature: MapFeature): boolean {
      return usedInSession.has(feature) || read()[feature] === true
    },
    markUsed(feature: MapFeature): void {
      usedInSession.add(feature)
      try {
        storage?.setItem(STORAGE_KEY, JSON.stringify({ ...read(), [feature]: true }))
      } catch {
        // Storage can be unavailable in private/locked-down contexts. The in-memory
        // state still prevents the label from reopening during this page session.
      }
    },
  }
}
