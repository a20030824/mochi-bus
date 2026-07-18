import { TDX_ACCESS_TOKEN_REJECTED_CODE } from '../../src/domain/tdx-api-error'
import { invalidateRejectedTdxAccessToken, tdxHeaders } from './client'

type ErrorPayload = {
  code?: unknown
  error?: unknown
}

export class MochiApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = 'MochiApiError'
  }
}

export function isTdxTokenRejectedError(error: unknown): error is MochiApiError {
  return error instanceof MochiApiError && error.code === TDX_ACCESS_TOKEN_REJECTED_CODE
}

type RequestOptions = {
  authenticated?: boolean
  fallback?: string
}

export async function requestMochiJson<T>(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<T> {
  const fallback = options.fallback ?? '資料讀取失敗'
  const first = await sendJsonRequest<T>(url, init, options.authenticated === true)

  if (shouldRefreshTdxToken(first.response, first.data, first.authorization)) {
    await invalidateRejectedTdxAccessToken(first.authorization)
    const retried = await sendJsonRequest<T>(url, init, true)
    return unwrapJsonResponse(retried.response, retried.data, fallback)
  }

  return unwrapJsonResponse(first.response, first.data, fallback)
}

async function sendJsonRequest<T>(url: string, init: RequestInit, authenticated: boolean) {
  const headers = new Headers(init.headers)
  let authorization = ''
  if (authenticated) {
    const authHeaders = await tdxHeaders()
    authorization = authHeaders.Authorization ?? ''
    if (authorization) headers.set('Authorization', authorization)
    else headers.delete('Authorization')
  }
  const response = await fetch(url, { ...init, headers })
  return { response, data: await readJson<T>(response), authorization }
}

async function readJson<T>(response: Response): Promise<(T & ErrorPayload) | undefined> {
  try {
    return await response.json() as T & ErrorPayload
  } catch {
    return undefined
  }
}

function shouldRefreshTdxToken<T>(
  response: Response,
  data: (T & ErrorPayload) | undefined,
  authorization: string,
): authorization is string {
  return Boolean(authorization)
    && response.status === 401
    && data?.code === TDX_ACCESS_TOKEN_REJECTED_CODE
}

function unwrapJsonResponse<T>(
  response: Response,
  data: (T & ErrorPayload) | undefined,
  fallback: string,
): T {
  if (!response.ok) {
    const message = typeof data?.error === 'string' && data.error.trim() ? data.error : fallback
    throw new MochiApiError(
      message,
      response.status,
      typeof data?.code === 'string' ? data.code : undefined,
    )
  }
  if (!data) throw new Error(fallback)
  return data
}
