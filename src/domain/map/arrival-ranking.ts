export function selectRealtimeCandidates<T extends { scheduleMinutes: number | null }>(
  routes: T[],
  limit = 5,
  withinMinutes = 30,
): T[] {
  const scheduled = routes
    .filter((route) => route.scheduleMinutes !== null && route.scheduleMinutes <= withinMinutes)
    .sort((a, b) => (a.scheduleMinutes ?? Number.POSITIVE_INFINITY) - (b.scheduleMinutes ?? Number.POSITIVE_INFINITY))
  // 沒有班表估計 ≠ 沒在跑:雙北的班表常缺支線或缺方向,高頻車反而估不出時間。
  // 名額沒用滿就分給這些未知路線去查即時,不然它們會被釘死在「暫無資訊」。
  const unknown = routes.filter((route) => route.scheduleMinutes === null)
  return [...scheduled, ...unknown].slice(0, limit)
}

export function includeFocusedCandidate<T>(candidates: T[], focused: T | undefined, limit = 5): T[] {
  if (!focused || candidates.includes(focused)) return candidates.slice(0, limit)
  return [focused, ...candidates.filter((candidate) => candidate !== focused)].slice(0, limit)
}
