import { describe, expect, it } from 'vitest'
import { selectRouteVariant } from './route-variant-selection'

const variants = [
  { variantKey: 'outbound', label: '去程' },
  { variantKey: 'inbound', label: '返程' },
]

describe('selectRouteVariant', () => {
  it('selects the requested variant from a deep link', () => {
    expect(selectRouteVariant(variants, 'inbound')).toEqual({
      kind: 'variant',
      variant: variants[1],
      pickerUsed: false,
    })
  })

  it('opens the picker when a preferred key is stale and multiple variants remain', () => {
    expect(selectRouteVariant(variants, 'retired')).toEqual({
      kind: 'picker',
      variants,
      pickerUsed: true,
    })
  })

  it('selects the only variant even when the preferred key is stale', () => {
    expect(selectRouteVariant([variants[0]], 'retired')).toEqual({
      kind: 'variant',
      variant: variants[0],
      pickerUsed: false,
    })
  })

  it('opens the picker when no preference is supplied for multiple variants', () => {
    expect(selectRouteVariant(variants)).toEqual({
      kind: 'picker',
      variants,
      pickerUsed: true,
    })
    expect(selectRouteVariant(variants, null)).toEqual({
      kind: 'picker',
      variants,
      pickerUsed: true,
    })
  })

  it('preserves the existing empty-picker contract without marking it as user-visible selection', () => {
    expect(selectRouteVariant([])).toEqual({
      kind: 'picker',
      variants: [],
      pickerUsed: false,
    })
  })

  it('uses the first matching variant when malformed data contains duplicate keys', () => {
    const duplicate = [
      { variantKey: 'same', label: 'first' },
      { variantKey: 'same', label: 'second' },
    ]
    expect(selectRouteVariant(duplicate, 'same')).toEqual({
      kind: 'variant',
      variant: duplicate[0],
      pickerUsed: false,
    })
  })
})
