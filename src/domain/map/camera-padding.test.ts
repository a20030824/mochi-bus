import { describe, expect, it } from 'vitest'
import {
  calculateCameraPadding,
  cameraPanOffset,
  DEFAULT_CAMERA_PADDING_OPTIONS,
  type CameraRect,
} from './camera-padding'

function rect(left: number, top: number, right: number, bottom: number): CameraRect {
  return { left, top, right, bottom, width: right - left, height: bottom - top }
}

const basePadding = {
  paddingTopLeft: [45, 90],
  paddingBottomRight: [45, 45],
} as const

describe('camera padding', () => {
  it('returns base padding when the drawer is absent', () => {
    expect(calculateCameraPadding(rect(0, 0, 1000, 800))).toEqual(basePadding)
  })

  it.each([
    { label: 'zero width', drawer: { ...rect(800, 400, 1000, 800), width: 0 } },
    { label: 'NaN height', drawer: { ...rect(800, 400, 1000, 800), height: Number.NaN } },
    { label: 'non-finite edge', drawer: { ...rect(800, 400, 1000, 800), right: Number.POSITIVE_INFINITY } },
  ])('falls back safely for a drawer with $label', ({ drawer }) => {
    expect(calculateCameraPadding(rect(0, 0, 1000, 800), drawer)).toEqual(basePadding)
  })

  it('does not add padding when the drawer is outside the map', () => {
    expect(calculateCameraPadding(rect(0, 0, 1000, 800), rect(1100, 100, 1400, 700))).toEqual(basePadding)
  })

  it('uses the right side for a desktop side panel without also reserving its height', () => {
    expect(calculateCameraPadding(
      rect(0, 0, 1440, 900),
      rect(1022, 400, 1422, 882),
    )).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [466, 45],
    })
  })

  it('uses the bottom for a mobile bottom sheet while keeping right padding near the base', () => {
    expect(calculateCameraPadding(
      rect(0, 0, 390, 844),
      rect(10, 481, 380, 834),
    )).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [45, 411],
    })
  })

  it('uses only the actual overlap when the drawer extends beyond the map', () => {
    expect(calculateCameraPadding(
      rect(0, 0, 1000, 800),
      rect(900, 650, 1200, 950),
    )).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [148, 45],
    })
  })

  it('clamps a drawer larger than the map to preserve visible map height', () => {
    const result = calculateCameraPadding(
      rect(0, 0, 1000, 800),
      rect(-100, -100, 1200, 1000),
    )

    expect(result).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [45, 530],
    })
    expect(800 - result.paddingTopLeft[1] - result.paddingBottomRight[1]).toBe(
      DEFAULT_CAMERA_PADDING_OPTIONS.minVisibleHeight,
    )
  })

  it('keeps every value finite and non-negative on an extremely small map', () => {
    const result = calculateCameraPadding(
      rect(0, 0, 60, 50),
      rect(-10, -10, 80, 70),
    )

    expect([...result.paddingTopLeft, ...result.paddingBottomRight].every((value) => Number.isFinite(value) && value >= 0)).toBe(true)
    expect(result.paddingTopLeft[0] + result.paddingBottomRight[0]).toBeLessThanOrEqual(60)
    expect(result.paddingTopLeft[1] + result.paddingBottomRight[1]).toBeLessThanOrEqual(50)
  })

  it('does not modify either input rectangle', () => {
    const mapRect = rect(0, 0, 1440, 900)
    const drawerRect = rect(1022, 400, 1422, 882)
    const before = structuredClone({ mapRect, drawerRect })

    calculateCameraPadding(mapRect, drawerRect)

    expect({ mapRect, drawerRect }).toEqual(before)
  })

  it('converts drawer padding into the pan needed to center a point in the visible map', () => {
    const desktop = calculateCameraPadding(
      rect(0, 0, 1440, 900),
      rect(1022, 400, 1422, 882),
    )
    const mobile = calculateCameraPadding(
      rect(0, 0, 390, 844),
      rect(10, 481, 380, 834),
    )

    expect(cameraPanOffset(desktop)).toEqual([210.5, -22.5])
    expect(cameraPanOffset(mobile)).toEqual([0, 160.5])
  })

  it('treats the bottom-sheet threshold as inclusive and the value just below it as a side panel', () => {
    const mapRect = rect(0, 0, 1000, 800)
    const atThreshold = calculateCameraPadding(mapRect, rect(280, 600, 1000, 800))
    const belowThreshold = calculateCameraPadding(mapRect, rect(281, 600, 1000, 800))

    expect(atThreshold).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [45, 248],
    })
    expect(belowThreshold).toEqual({
      paddingTopLeft: [45, 90],
      paddingBottomRight: [767, 45],
    })
  })
})
