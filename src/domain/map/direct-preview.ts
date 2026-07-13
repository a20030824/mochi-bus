export type DirectPreviewEntry<T> = {
  route: T
  index: number
}

/**
 * Select the bounded set of direct routes that should be loaded on the map.
 * The index always refers to the route's position in the original array.
 */
export function selectDirectPreviewEntries<T>(
  routes: T[],
  selectedIndex: number,
  limit = 8,
): DirectPreviewEntry<T>[] {
  if (!routes.length || limit <= 0) return []

  const normalizedIndex = Math.min(
    Math.max(Number.isFinite(selectedIndex) ? Math.trunc(selectedIndex) : 0, 0),
    routes.length - 1,
  )
  const previewCount = Math.min(routes.length, Math.trunc(limit))
  if (previewCount <= 0) return []

  const indexes = normalizedIndex < previewCount
    ? Array.from({ length: previewCount }, (_, index) => index)
    : [
        ...Array.from({ length: previewCount - 1 }, (_, index) => index),
        normalizedIndex,
      ]

  return indexes.map((index) => ({ route: routes[index], index }))
}
