export type Direction = 0 | 1

export type BusQuery = {
  city: string
  routeName: string
  stopName?: string
  stopUid?: string
  routeUid?: string
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
  const directionValue = clean(input.direction) ?? fallback?.direction?.toString()

  if (!city) throw new QueryValidationError('缺少縣市')
  if (supportedCities && !supportedCities.has(city)) {
    throw new QueryValidationError(`不支援的縣市：${city}`)
  }
  if (!routeName) throw new QueryValidationError('缺少公車路線')
  if (routeName.length > 40) throw new QueryValidationError('公車路線過長')
  if (!stopName && !stopUid) throw new QueryValidationError('缺少站牌名稱或 StopUID')
  if (stopName && stopName.length > 80) throw new QueryValidationError('站牌名稱過長')
  if (directionValue !== '0' && directionValue !== '1') {
    throw new QueryValidationError('direction 必須是 0 或 1')
  }

  return {
    city,
    routeName,
    stopName,
    stopUid,
    routeUid,
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
