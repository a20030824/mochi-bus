import { getTdxAuth, type TdxAuth } from '../boards/store'

const TOKEN_ENDPOINT = 'https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token'
const TOKEN_REQUEST_TIMEOUT_MS = 8_000
const TOKEN_CACHE_MAX_SECONDS = 10 * 60
const MAX_TOKEN_CACHE_ENTRIES = 16

type TokenCacheEntry = {
  accessToken: string
  expiresAt: number
}

const tokenCache = new Map<string, TokenCacheEntry>()
const pendingTokens = new Map<string, Promise<string>>()

export async function tdxHeaders(): Promise<Record<string, string>> {
  const auth = getTdxAuth()
  if (!auth) return {}
  return { Authorization: `Bearer ${await accessTokenFor(auth)}` }
}

// 只淘汰「這次真的被拒絕」的 token。若多個 API 同時收到 401，第一個請求
// 可能已換到新 token；後到的 401 不得把那顆新 token 一併清掉。
export async function invalidateRejectedTdxAccessToken(authorization: string): Promise<void> {
  const auth = getTdxAuth()
  if (!auth) return
  const rejectedToken = bearerToken(authorization)
  if (!rejectedToken) return
  const key = await credentialFingerprint(auth)
  if (tokenCache.get(key)?.accessToken === rejectedToken) tokenCache.delete(key)
}

export async function verifyTdxCredentials(auth: TdxAuth): Promise<void> {
  const key = await credentialFingerprint(auth)
  tokenCache.delete(key)
  await accessTokenFor(auth, key)
}

export function clearTdxAccessTokenCache(): void {
  tokenCache.clear()
  pendingTokens.clear()
}

export function resetTdxClientForTests(): void {
  clearTdxAccessTokenCache()
}

async function accessTokenFor(auth: TdxAuth, knownKey?: string): Promise<string> {
  const key = knownKey ?? await credentialFingerprint(auth)
  const cached = cachedToken(key)
  if (cached) return cached

  const pending = pendingTokens.get(key)
  if (pending) return pending

  const request = exchangeToken(auth, key)
  pendingTokens.set(key, request)
  try {
    return await request
  } finally {
    if (pendingTokens.get(key) === request) pendingTokens.delete(key)
  }
}

async function exchangeToken(auth: TdxAuth, key: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: auth.clientId,
        client_secret: auth.clientSecret,
      }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new Error('無法連上 TDX，請稍後再試')
  }

  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error('TDX 憑證無效，請重新確認 Client ID 與 Client Secret')
    }
    throw new Error('TDX 暫時無法驗證憑證，請稍後再試')
  }

  let data: { access_token?: unknown; expires_in?: unknown }
  try {
    data = await response.json() as { access_token?: unknown; expires_in?: unknown }
  } catch {
    throw new Error('TDX 回傳格式異常，請稍後再試')
  }

  if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8_192) {
    throw new Error('TDX 回傳格式異常，請稍後再試')
  }

  const reportedSeconds = typeof data.expires_in === 'number' && Number.isFinite(data.expires_in)
    ? data.expires_in
    : TOKEN_CACHE_MAX_SECONDS
  const usableSeconds = Math.max(30, Math.min(reportedSeconds, TOKEN_CACHE_MAX_SECONDS) - 60)
  cacheToken(key, { accessToken: data.access_token, expiresAt: Date.now() + usableSeconds * 1_000 })
  return data.access_token
}

async function credentialFingerprint(auth: TdxAuth): Promise<string> {
  const input = new TextEncoder().encode(`tdx-browser\0${auth.clientId}\0${auth.clientSecret}`)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function cachedToken(key: string): string | undefined {
  const entry = tokenCache.get(key)
  if (!entry) return undefined
  if (entry.expiresAt <= Date.now()) {
    tokenCache.delete(key)
    return undefined
  }
  tokenCache.delete(key)
  tokenCache.set(key, entry)
  return entry.accessToken
}

function cacheToken(key: string, entry: TokenCacheEntry): void {
  tokenCache.delete(key)
  tokenCache.set(key, entry)
  while (tokenCache.size > MAX_TOKEN_CACHE_ENTRIES) {
    const oldest = tokenCache.keys().next().value
    if (oldest === undefined) break
    tokenCache.delete(oldest)
  }
}

function bearerToken(authorization: string): string | undefined {
  const prefix = 'Bearer '
  return authorization.startsWith(prefix) ? authorization.slice(prefix.length) || undefined : undefined
}
