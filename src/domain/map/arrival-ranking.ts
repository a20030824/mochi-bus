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

export function includeFocusedCandidate<T>(candidates: T[], focused: T | undefined, limit = 3): T[] {
  if (!focused || candidates.includes(focused)) return candidates.slice(0, limit)
  return [focused, ...candidates.filter((candidate) => candidate !== focused)].slice(0, limit)
}
