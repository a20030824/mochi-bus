export const JOURNEY_ETA_BODY_LIMIT_BYTES = 16 * 1024

export type ApiInputStatus = 400 | 413 | 415 | 422
export type ApiInputCode =
  | 'INVALID_JSON'
  | 'INVALID_QUERY'
  | 'INVALID_REQUEST'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'

export class ApiInputError extends Error {
  constructor(
    readonly status: ApiInputStatus,
    readonly code: ApiInputCode,
    message: string,
  ) {
    super(message)
    this.name = 'ApiInputError'
  }
}

export type JourneyEtaLegInput = {
  key: string
  patternId: string
  sequence: number
}

export type JourneyEtaInput = {
  city: string
  legs: JourneyEtaLegInput[]
}

export async function readJsonBody(request: Request): Promise<unknown> {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  const isJson = mediaType === 'application/json'
    || Boolean(mediaType?.startsWith('application/') && mediaType.endsWith('+json'))
  if (!isJson) {
    throw new ApiInputError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type 必須是 application/json')
  }

  try {
    return await request.json()
  } catch {
    throw new ApiInputError(400, 'INVALID_JSON', '請求內容不是有效的 JSON')
  }
}

export function parseJourneyEtaInput(
  value: unknown,
  supportedCities: ReadonlySet<string>,
): JourneyEtaInput {
  if (!isRecord(value)) invalidRequest('ETA 查詢內容格式錯誤')

  const city = typeof value.city === 'string' ? value.city.trim() : ''
  if (!city || !supportedCities.has(city)) invalidRequest('請選擇有效縣市')
  if (!Array.isArray(value.legs) || value.legs.length < 1 || value.legs.length > 12) {
    invalidRequest('ETA 查詢項目必須介於 1 到 12 筆')
  }

  const seenKeys = new Set<string>()
  const legs = value.legs.map((leg) => {
    if (!isRecord(leg)) invalidRequest('ETA 查詢項目格式錯誤')
    const key = requiredStringValue(leg.key, 80, 'ETA key')
    const patternId = requiredStringValue(leg.patternId, 100, '路線識別碼')
    const sequence = leg.sequence
    if (!Number.isInteger(sequence) || (sequence as number) < 0 || (sequence as number) > 10_000) {
      invalidRequest('站序必須是 0 到 10000 的整數')
    }
    if (seenKeys.has(key)) invalidRequest('ETA key 不可重複')
    seenKeys.add(key)
    return { key, patternId, sequence: sequence as number }
  })

  return { city, legs }
}

export function requiredQueryString(value: string | undefined, label: string, maxLength: number): string {
  const cleaned = value?.trim()
  if (!cleaned) throw new ApiInputError(400, 'INVALID_QUERY', `${label}不可空白`)
  if (cleaned.length > maxLength) throw new ApiInputError(400, 'INVALID_QUERY', `${label}格式錯誤`)
  return cleaned
}

export function optionalQueryString(value: string | undefined, label: string, maxLength: number): string | undefined {
  const cleaned = value?.trim()
  if (!cleaned) return undefined
  if (cleaned.length > maxLength) throw new ApiInputError(400, 'INVALID_QUERY', `${label}格式錯誤`)
  return cleaned
}

export function parseOptionalDirection(value: string | undefined, label = 'direction'): 0 | 1 | undefined {
  if (value === undefined || value.trim() === '') return undefined
  const cleaned = value.trim()
  if (cleaned !== '0' && cleaned !== '1') {
    throw new ApiInputError(400, 'INVALID_QUERY', `${label} 必須是 0 或 1`)
  }
  return Number(cleaned) as 0 | 1
}

export function parseCoordinate(value: string | undefined, axis: 'latitude' | 'longitude'): number {
  const cleaned = value?.trim()
  const label = axis === 'latitude' ? '緯度' : '經度'
  if (!cleaned || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) {
    throw new ApiInputError(400, 'INVALID_QUERY', `${label}格式錯誤`)
  }
  const coordinate = Number(cleaned)
  const limit = axis === 'latitude' ? 90 : 180
  if (!Number.isFinite(coordinate) || coordinate < -limit || coordinate > limit) {
    throw new ApiInputError(400, 'INVALID_QUERY', `${label}超出有效範圍`)
  }
  return coordinate
}

export function parseRadius(value: string | undefined, fallback = 500): number {
  if (value === undefined || value.trim() === '') return fallback
  const cleaned = value.trim()
  if (!/^\d+$/.test(cleaned)) throw new ApiInputError(400, 'INVALID_QUERY', '搜尋半徑格式錯誤')
  const radius = Number(cleaned)
  if (!Number.isInteger(radius) || radius < 50 || radius > 2_000) {
    throw new ApiInputError(400, 'INVALID_QUERY', '搜尋半徑必須介於 50 到 2000 公尺')
  }
  return radius
}

export function parseTdxCredentials(
  clientIdValue: string | undefined,
  clientSecretValue: string | undefined,
  required = false,
): { clientId: string; clientSecret: string } | null {
  const clientId = clientIdValue?.trim()
  const clientSecret = clientSecretValue?.trim()
  if (!clientId && !clientSecret) {
    if (required) throw new ApiInputError(400, 'INVALID_REQUEST', 'Client ID 與 Client Secret 都要填')
    return null
  }
  if (!clientId || !clientSecret) {
    throw new ApiInputError(400, 'INVALID_REQUEST', 'Client ID 與 Client Secret 必須一起提供')
  }
  if (clientId.length > 120 || clientSecret.length > 240) {
    throw new ApiInputError(400, 'INVALID_REQUEST', 'TDX 憑證格式錯誤')
  }
  return { clientId, clientSecret }
}

export function apiInputErrorBody(error: ApiInputError): { error: string; code: ApiInputCode } {
  return { error: error.message, code: error.code }
}

function requiredStringValue(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== 'string') invalidRequest(`${label}格式錯誤`)
  const cleaned = value.trim()
  if (!cleaned || cleaned.length > maxLength) invalidRequest(`${label}格式錯誤`)
  return cleaned
}

function invalidRequest(message: string): never {
  throw new ApiInputError(422, 'INVALID_REQUEST', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

