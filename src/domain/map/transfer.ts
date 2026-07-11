export type TransferLegCandidate = {
  patternId: string
  routeUid: string
  routeName: string
  label: string
  placeId: string
  placeName: string
  latitude: number
  longitude: number
  boardSequence: number
  alightSequence: number
  stopCount: number
}

export type TransferPlanLeg = {
  routeName: string
  variantKey: string
  label: string
  boardSequence: number
  alightSequence: number
  stopCount: number
}

export type TransferPlanResult = {
  transferPlaceId: string
  secondTransferPlaceId: string
  transferName: string
  transferWalkMeters: number
  totalStops: number
  first: TransferPlanLeg
  second: TransferPlanLeg
}

const WALK_LIMIT_METERS = 350
const GRID_DEGREES = 0.0035
const EARTH_RADIUS_METERS = 6_371_000

// 一次轉乘的接合:前向可達集(從起點可直達的下車點)×反向可達集(可直達終點的上車點),
// 以步行距離 ≤ 350m 的站位配對。舊版把這一步塞在 SQL 的經緯度 box join 裡,
// 用不到索引,大城市會撞 D1 CPU 上限;這裡改用網格索引在記憶體做,成本隨城市線性成長。
export function pairTransferLegs(
  forward: TransferLegCandidate[],
  backward: TransferLegCandidate[],
  limit = 5,
): TransferPlanResult[] {
  const forwardLegs = dedupeBestLegs(forward)
  const backwardLegs = dedupeBestLegs(backward)

  const grid = new Map<string, TransferLegCandidate[]>()
  for (const leg of backwardLegs) {
    const key = gridKey(leg.latitude, leg.longitude)
    const bucket = grid.get(key)
    if (bucket) bucket.push(leg)
    else grid.set(key, [leg])
  }

  const best = new Map<string, TransferPlanResult>()
  for (const first of forwardLegs) {
    const latCell = Math.floor(first.latitude / GRID_DEGREES)
    const lonCell = Math.floor(first.longitude / GRID_DEGREES)
    const { latitude: latitudeCells, longitude: longitudeCells } = neighborCellSpan(first.latitude)
    for (let dLat = -latitudeCells; dLat <= latitudeCells; dLat += 1) {
      for (let dLon = -longitudeCells; dLon <= longitudeCells; dLon += 1) {
        for (const second of grid.get(`${latCell + dLat}:${lonCell + dLon}`) ?? []) {
          if (second.routeUid === first.routeUid) continue
          const walk = distanceMeters(first.latitude, first.longitude, second.latitude, second.longitude)
          if (walk > WALK_LIMIT_METERS) continue
          const plan: TransferPlanResult = {
            transferPlaceId: first.placeId,
            secondTransferPlaceId: second.placeId,
            transferName: first.placeId === second.placeId
              ? first.placeName
              : `${first.placeName} ↔ ${second.placeName}`,
            transferWalkMeters: Math.round(walk),
            totalStops: first.stopCount + second.stopCount,
            first: toPlanLeg(first),
            second: toPlanLeg(second),
          }
          const key = `${plan.first.routeName}:${plan.second.routeName}:${plan.transferPlaceId}:${plan.secondTransferPlaceId}`
          const existing = best.get(key)
          if (!existing || score(plan) < score(existing)) best.set(key, plan)
        }
      }
    }
  }

  return [...best.values()].sort((a, b) => score(a) - score(b)).slice(0, limit)
}

// 同一路線可能在同站有多個上下車組合(環狀線、重複停靠),配對前先各留最短的一筆。
function dedupeBestLegs(legs: TransferLegCandidate[]): TransferLegCandidate[] {
  const best = new Map<string, TransferLegCandidate>()
  for (const leg of legs) {
    const key = `${leg.patternId}:${leg.placeId}`
    const existing = best.get(key)
    if (!existing || leg.stopCount < existing.stopCount) best.set(key, leg)
  }
  return [...best.values()]
}

function toPlanLeg(leg: TransferLegCandidate): TransferPlanLeg {
  return {
    routeName: leg.routeName,
    variantKey: leg.patternId,
    label: leg.label,
    boardSequence: leg.boardSequence,
    alightSequence: leg.alightSequence,
    stopCount: leg.stopCount,
  }
}

function score(plan: TransferPlanResult): number {
  return plan.totalStops + plan.transferWalkMeters / 100
}

function gridKey(latitude: number, longitude: number): string {
  return `${Math.floor(latitude / GRID_DEGREES)}:${Math.floor(longitude / GRID_DEGREES)}`
}

// 固定角度網格的實際經度寬度會隨緯度縮小。用球面步行半徑推導候選圓的
// 最大經緯度跨度，再決定要掃幾格；精確 350m 判斷仍由 Haversine 負責。
function neighborCellSpan(latitude: number): { latitude: number; longitude: number } {
  const angularRadius = WALK_LIMIT_METERS / EARTH_RADIUS_METERS
  const latitudeDelta = angularRadius * 180 / Math.PI
  const cosine = Math.max(0.01, Math.abs(Math.cos(latitude * Math.PI / 180)))
  const longitudeDelta = Math.asin(Math.min(1, Math.sin(angularRadius) / cosine)) * 180 / Math.PI
  return {
    latitude: Math.ceil(latitudeDelta / GRID_DEGREES),
    longitude: Math.ceil(longitudeDelta / GRID_DEGREES),
  }
}

function distanceMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRadians = (value: number) => value * Math.PI / 180
  const deltaLat = toRadians(lat2 - lat1)
  const deltaLon = toRadians(lon2 - lon1)
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(deltaLon / 2) ** 2
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}
