import { describe, expect, it } from 'vitest'
import { createMapFeatureDiscovery } from './feature-discovery'

function memoryStorage(initial?: string) {
  let value = initial ?? null
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next },
    value: () => value,
  }
}

describe('map feature discovery', () => {
  it('persists each used feature independently', () => {
    const storage = memoryStorage()
    const discovery = createMapFeatureDiscovery(storage)

    expect(discovery.hasUsed('network')).toBe(false)
    expect(discovery.hasUsed('trip')).toBe(false)

    discovery.markUsed('network')

    expect(discovery.hasUsed('network')).toBe(true)
    expect(discovery.hasUsed('trip')).toBe(false)
    expect(JSON.parse(storage.value() ?? '{}')).toEqual({ network: true })
    expect(createMapFeatureDiscovery(storage).hasUsed('network')).toBe(true)
  })

  it('ignores malformed persisted data', () => {
    const discovery = createMapFeatureDiscovery(memoryStorage('{not-json'))

    expect(discovery.hasUsed('network')).toBe(false)
    expect(discovery.hasUsed('trip')).toBe(false)
  })

  it('keeps the current-page state when storage throws', () => {
    const storage = {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    }
    const discovery = createMapFeatureDiscovery(storage)

    discovery.markUsed('trip')

    expect(discovery.hasUsed('trip')).toBe(true)
  })
})
