export function retainRoutesWithPatterns({ routes, schedules, patterns }) {
  if (!(routes instanceof Map) || !(schedules instanceof Map) || !Array.isArray(patterns)) {
    throw new Error('Invalid route catalogue inputs')
  }

  const patternedRouteUids = new Set(patterns.map((pattern) => pattern?.routeUid).filter(Boolean))
  const removedRouteUids = []

  for (const routeUid of routes.keys()) {
    if (patternedRouteUids.has(routeUid)) continue
    routes.delete(routeUid)
    schedules.delete(routeUid)
    removedRouteUids.push(routeUid)
  }

  return Object.freeze([...removedRouteUids])
}
