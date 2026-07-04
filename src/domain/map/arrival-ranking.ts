export function selectRealtimeCandidates<T extends { scheduleMinutes: number | null }>(
  routes: T[],
  limit = 3,
  withinMinutes = 30,
): T[] {
  return routes
    .filter((route) => route.scheduleMinutes !== null && route.scheduleMinutes <= withinMinutes)
    .sort((a, b) => (a.scheduleMinutes ?? Number.POSITIVE_INFINITY) - (b.scheduleMinutes ?? Number.POSITIVE_INFINITY))
    .slice(0, limit)
}
