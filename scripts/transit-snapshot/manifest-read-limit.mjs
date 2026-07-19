const MEBIBYTE = 1024 * 1024
const MANIFEST_READ_SLACK_BYTES = 64 * 1024

export const DEFAULT_JSON_READ_LIMIT = MEBIBYTE
export const MAX_MANIFEST_READ_LIMIT = 16 * MEBIBYTE

export function manifestReadLimit(expectedManifest) {
  const expectedBytes = Buffer.byteLength(JSON.stringify(expectedManifest))
  const requestedBytes = Math.max(
    DEFAULT_JSON_READ_LIMIT,
    expectedBytes + MANIFEST_READ_SLACK_BYTES,
  )
  if (requestedBytes > MAX_MANIFEST_READ_LIMIT) {
    throw new Error('Snapshot manifest exceeds the remote validation safety limit')
  }
  return requestedBytes
}
