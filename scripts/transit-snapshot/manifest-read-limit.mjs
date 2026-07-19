const MEBIBYTE = 1024 * 1024
const MANIFEST_READ_SLACK_BYTES = 64 * 1024

export const DEFAULT_JSON_READ_LIMIT = MEBIBYTE
export const MAX_MANIFEST_READ_LIMIT = 16 * MEBIBYTE

export function manifestReadLimitFromBytes(expectedBytes) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new Error('Snapshot manifest size is unavailable')
  }
  if (expectedBytes > MAX_MANIFEST_READ_LIMIT) {
    throw new Error('Snapshot manifest exceeds the remote validation safety limit')
  }
  return Math.max(
    DEFAULT_JSON_READ_LIMIT,
    Math.min(MAX_MANIFEST_READ_LIMIT, expectedBytes + MANIFEST_READ_SLACK_BYTES),
  )
}

export function manifestReadLimit(expectedManifest) {
  return manifestReadLimitFromBytes(Buffer.byteLength(JSON.stringify(expectedManifest)))
}

export async function readManifestJson({ key, head, getJson }) {
  const metadata = await head(key)
  if (!metadata) return null
  return getJson(key, manifestReadLimitFromBytes(metadata.size))
}
