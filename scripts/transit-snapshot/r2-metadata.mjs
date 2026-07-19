export function parseContentLength(value) {
  if (value === null) return null
  const size = Number(value)
  return Number.isSafeInteger(size) && size >= 0 ? size : null
}
