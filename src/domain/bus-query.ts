export type Direction = 0 | 1 | 2

export type BusQuery = {
  city: string
  routeName: string
  stopName?: string
  stopUid?: string
  routeUid?: string
  // 同一站牌可能有多條支線共用同一個 stopUid;有這個欄位時用來排除其他支線。
  subRouteUid?: string
  direction: Direction
}

export type ResolvedBusQuery = BusQuery & {
  stopName: string
  stopUid: string
}

export type QueryInput = Record<string, string | undefined>

export class QueryValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryValidationError'
  }
}

export function parseBusQuery(
  input: QueryInput,
  fallback?: BusQuery,
  supportedCities?: ReadonlySet<string>,
): BusQuery {
  const city = clean(input.city) ?? fallback?.city
  const routeName = clean(input.route) ?? clean(input.routeName) ?? fallback?.routeName
  const stopName = clean(input.stop) ?? clean(input.stopName) ?? fallback?.stopName
  const stopUid = clean(input.stopUid) ?? fallback?.stopUid
  const routeUid = clean(input.routeUid) ?? fallback?.routeUid
  const subRouteUid = clean(input.subRouteUid) ?? fallback?.subRouteUid
  const directionValue = clean(input.direction) ?? fallback?.direction?.toString()

  if (!city) throw new QueryValidationError('缺少縣市')
  if (supportedCities && !supportedCities.has(city)) {
    throw new QueryValidationError(`不支援的縣市：${city}`)
  }
  if (!routeName) throw new QueryValidationError('缺少公車路線')
  if (routeName.length > 40) throw new QueryValidationError('公車路線過長')
  if (!stopName && !stopUid) throw new QueryValidationError('缺少站牌名稱或 StopUID')
  if (stopName && stopName.length > 80) throw new QueryValidationError('站牌名稱過長')
  if (stopUid && stopUid.length > 100) throw new QueryValidationError('StopUID 格式錯誤')
  if (routeUid && routeUid.length > 100) throw new QueryValidationError('RouteUID 格式錯誤')
  if (subRouteUid && subRouteUid.length > 100) throw new QueryValidationError('SubRouteUID 格式錯誤')
  if (directionValue !== '0' && directionValue !== '1' && directionValue !== '2') {
    throw new QueryValidationError('direction 必須是 0、1 或 2')
  }

  return {
    city,
    routeName,
    stopName,
    stopUid,
    routeUid,
    subRouteUid,
    direction: Number(directionValue) as Direction,
  }
}

export function toBusSearchParams(query: BusQuery): URLSearchParams {
  const params = new URLSearchParams({
    city: query.city,
    route: query.routeName,
    direction: query.direction.toString(),
  })

  if (query.stopName) params.set('stop', query.stopName)
  if (query.stopUid) params.set('stopUid', query.stopUid)
  if (query.routeUid) params.set('routeUid', query.routeUid)
  if (query.subRouteUid) params.set('subRouteUid', query.subRouteUid)
  return params
}

export function canonicalBusPath(query: ResolvedBusQuery): string {
  return `/bus?${toBusSearchParams(query).toString()}`
}

function clean(value: string | undefined): string | undefined {
  const cleaned = value?.trim()
  if (cleaned?.toLowerCase() === 'undefined' || cleaned?.toLowerCase() === 'null') return undefined
  return cleaned ? cleaned : undefined
}
