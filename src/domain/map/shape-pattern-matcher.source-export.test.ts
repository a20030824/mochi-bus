import { readFileSync } from 'node:fs'
import { describe, it } from 'vitest'

function emitBase64Chunks(label: string, path: string): void {
  const encoded = readFileSync(path).toString('base64')
  const chunkSize = 4_000
  const chunks = Math.ceil(encoded.length / chunkSize)
  console.log(`SOURCE_EXPORT_BEGIN:${label}:${chunks}`)
  for (let index = 0; index < chunks; index += 1) {
    console.log(`SOURCE_EXPORT_CHUNK:${label}:${index}:${encoded.slice(index * chunkSize, (index + 1) * chunkSize)}`)
  }
  console.log(`SOURCE_EXPORT_END:${label}`)
}

describe('temporary matcher source export', () => {
  it('emits deterministic source chunks for connector-safe patching', () => {
    emitBase64Chunks('implementation', 'src/domain/map/shape-pattern-matcher.ts')
    emitBase64Chunks('review2', 'src/domain/map/shape-pattern-matcher.review2.test.ts')
    emitBase64Chunks('review3', 'src/domain/map/shape-pattern-matcher.review3.test.ts')
  })
})
