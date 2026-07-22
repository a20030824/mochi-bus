import { describe, expect, it } from 'vitest'
import { meters, pattern, shape } from './shape-pattern-matcher.fixtures'
import {
  matchShapesToPatterns,
  type ShapePatternMatcherOptions,
} from './shape-pattern-matcher'

const NUMERIC_OPTION_NAMES = [
  'ambiguityAbsoluteMeters',
  'ambiguityRelativeRatio',
  'maxMeanStopDistanceMeters',
  'maxStopDistanceMeters',
  'maxEndpointDistanceMeters',
  'circularShapeMaxGapMeters',
] as const satisfies readonly (keyof ShapePatternMatcherOptions)[]

type NumericOptionName = typeof NUMERIC_OPTION_NAMES[number]

function optionsWith(name: NumericOptionName, value: number): ShapePatternMatcherOptions {
  return { [name]: value } as ShapePatternMatcherOptions
}

function geometryFixture(options: ShapePatternMatcherOptions = {}) {
  const routeUid = 'ROUTE-OPTION-CONTRACT'
  return () => matchShapesToPatterns(
    [pattern('PATTERN', routeUid, 0, [meters(0, 0), meters(100, 0)])],
    [shape('SHAPE', routeUid, 0, [meters(0, 0), meters(100, 0)])],
    options,
  )
}

function expectInvalidOption(name: NumericOptionName, value: number): void {
  const result = geometryFixture(optionsWith(name, value))
  expect(result).toThrow(RangeError)
  expect(result).toThrow(
    `ShapePatternMatcher option "${name}" must be a finite non-negative number.`,
  )
}

describe('matcher options validation', () => {
  it('rejects an infinite circular gap before a Direction 2 Shape can reach identity or geometry matching', () => {
    const result = () => matchShapesToPatterns(
      [
        pattern(
          'PATTERN',
          'ROUTE-INFINITE-LIMIT',
          2,
          [meters(0, 0), meters(0, 1_000)],
          'SUB-LOOP',
        ),
      ],
      [
        shape(
          'OPEN-SHAPE',
          'ROUTE-INFINITE-LIMIT',
          2,
          [
            meters(0, 0),
            meters(0, 1_000),
            meters(5_000, 1_000),
            meters(5_000, 0),
          ],
          'SUB-LOOP',
        ),
      ],
      {
        circularShapeMaxGapMeters: Number.POSITIVE_INFINITY,
      },
    )

    expect(result).toThrow(RangeError)
    expect(result).toThrow(/circularShapeMaxGapMeters/)
  })

  for (const optionName of NUMERIC_OPTION_NAMES) {
    describe(optionName, () => {
      for (const [label, value] of [
        ['NaN', Number.NaN],
        ['positive Infinity', Number.POSITIVE_INFINITY],
        ['negative Infinity', Number.NEGATIVE_INFINITY],
      ] as const) {
        it(`rejects ${label}`, () => {
          expectInvalidOption(optionName, value)
        })
      }

      for (const value of [-1, -Number.EPSILON]) {
        it(`rejects negative value ${value}`, () => {
          expectInvalidOption(optionName, value)
        })
      }

      it('accepts zero', () => {
        expect(geometryFixture(optionsWith(optionName, 0))).not.toThrow()
      })
    })
  }

  it('keeps defaults for omitted fields in a partial option object', () => {
    const expected = geometryFixture()()
    const actual = geometryFixture({ maxStopDistanceMeters: 1_000 })()

    expect(actual).toEqual(expected)
  })
})
