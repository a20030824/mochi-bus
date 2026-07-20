export type RouteVariantLike = {
  variantKey: string
}

export type RouteVariantSelection<Variant extends RouteVariantLike> =
  | {
      kind: 'variant'
      variant: Variant
      pickerUsed: false
    }
  | {
      kind: 'picker'
      variants: readonly Variant[]
      pickerUsed: boolean
    }

/**
 * Resolves a route deep link into either one concrete variant or the variant
 * picker. The function intentionally preserves an empty picker result because
 * the caller owns the existing empty/error presentation contract.
 */
export function selectRouteVariant<Variant extends RouteVariantLike>(
  variants: readonly Variant[],
  preferredVariant?: string | null,
): RouteVariantSelection<Variant> {
  const preferred = variants.find((variant) => variant.variantKey === preferredVariant)
  if (preferred) return { kind: 'variant', variant: preferred, pickerUsed: false }
  if (variants.length === 1) return { kind: 'variant', variant: variants[0], pickerUsed: false }
  return { kind: 'picker', variants, pickerUsed: variants.length > 1 }
}
