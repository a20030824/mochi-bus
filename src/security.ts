const HSTS_MAX_AGE_SECONDS = 86_400

const defaultSecurityHeaders = {
  'Content-Security-Policy': "base-uri 'self'; frame-ancestors 'none'; object-src 'none'",
  'Permissions-Policy': 'camera=(), geolocation=(self), microphone=(), payment=(), usb=()',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
} as const

function isLocalDevelopmentHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '127.0.0.1'
    || hostname === '0.0.0.0'
    || hostname === '[::1]'
}

export function httpsRedirectTarget(requestUrl: string): string | null {
  const url = new URL(requestUrl)
  if (url.protocol !== 'http:' || isLocalDevelopmentHost(url.hostname)) return null

  url.protocol = 'https:'
  return url.toString()
}

export function securityHeaders(isHttps: boolean): Readonly<Record<string, string>> {
  if (!isHttps) return defaultSecurityHeaders
  return {
    ...defaultSecurityHeaders,
    'Strict-Transport-Security': `max-age=${HSTS_MAX_AGE_SECONDS}`,
  }
}
