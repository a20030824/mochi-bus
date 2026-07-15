export type CameraRect = {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
}

export type CameraPadding = {
  paddingTopLeft: [number, number]
  paddingBottomRight: [number, number]
}

export type CameraPaddingOptions = {
  baseLeft: number
  baseTop: number
  baseRight: number
  baseBottom: number
  safetyGap: number
  bottomSheetWidthRatio: number
  minVisibleWidth: number
  minVisibleHeight: number
}

export const DEFAULT_CAMERA_PADDING_OPTIONS: CameraPaddingOptions = {
  baseLeft: 45,
  baseTop: 90,
  baseRight: 45,
  baseBottom: 45,
  safetyGap: 48,
  bottomSheetWidthRatio: 0.72,
  minVisibleWidth: 180,
  minVisibleHeight: 180,
}

export function calculateCameraPadding(
  mapRect: CameraRect,
  drawerRect?: CameraRect | null,
  overrides: Partial<CameraPaddingOptions> = {},
): CameraPadding {
  const options = resolveOptions(overrides)
  const mapSize = rectSize(mapRect)
  if (!isValidRect(mapRect) || !mapSize) return basePadding(options)

  let left = options.baseLeft
  let top = options.baseTop
  let right = options.baseRight
  let bottom = options.baseBottom

  if (isValidRect(drawerRect)) {
    const overlap = intersectRects(mapRect, drawerRect)
    if (overlap) {
      const bottomSheet = overlap.width / mapSize.width >= options.bottomSheetWidthRatio
      if (bottomSheet) {
        bottom = Math.max(bottom, mapRect.bottom - overlap.top + options.safetyGap)
      } else {
        right = Math.max(right, mapRect.right - overlap.left + options.safetyGap)
      }
    }
  }

  ;[left, right] = clampPaddingPair(left, right, mapSize.width, options.minVisibleWidth)
  ;[top, bottom] = clampPaddingPair(top, bottom, mapSize.height, options.minVisibleHeight)

  return {
    paddingTopLeft: [left, top],
    paddingBottomRight: [right, bottom],
  }
}

export function cameraPanOffset(padding: CameraPadding): [number, number] {
  const [left, top] = padding.paddingTopLeft
  const [right, bottom] = padding.paddingBottomRight
  return [
    (nonNegativeFinite(right, 0) - nonNegativeFinite(left, 0)) / 2,
    (nonNegativeFinite(bottom, 0) - nonNegativeFinite(top, 0)) / 2,
  ]
}

type RectSize = { width: number; height: number }
type RectOverlap = RectSize & { left: number; top: number; right: number; bottom: number }

function resolveOptions(overrides: Partial<CameraPaddingOptions>): CameraPaddingOptions {
  return {
    baseLeft: nonNegativeFinite(overrides.baseLeft, DEFAULT_CAMERA_PADDING_OPTIONS.baseLeft),
    baseTop: nonNegativeFinite(overrides.baseTop, DEFAULT_CAMERA_PADDING_OPTIONS.baseTop),
    baseRight: nonNegativeFinite(overrides.baseRight, DEFAULT_CAMERA_PADDING_OPTIONS.baseRight),
    baseBottom: nonNegativeFinite(overrides.baseBottom, DEFAULT_CAMERA_PADDING_OPTIONS.baseBottom),
    safetyGap: nonNegativeFinite(overrides.safetyGap, DEFAULT_CAMERA_PADDING_OPTIONS.safetyGap),
    bottomSheetWidthRatio: boundedFinite(
      overrides.bottomSheetWidthRatio,
      DEFAULT_CAMERA_PADDING_OPTIONS.bottomSheetWidthRatio,
      0,
      1,
    ),
    minVisibleWidth: nonNegativeFinite(overrides.minVisibleWidth, DEFAULT_CAMERA_PADDING_OPTIONS.minVisibleWidth),
    minVisibleHeight: nonNegativeFinite(overrides.minVisibleHeight, DEFAULT_CAMERA_PADDING_OPTIONS.minVisibleHeight),
  }
}

function basePadding(options: CameraPaddingOptions): CameraPadding {
  return {
    paddingTopLeft: [options.baseLeft, options.baseTop],
    paddingBottomRight: [options.baseRight, options.baseBottom],
  }
}

function isValidRect(rect?: CameraRect | null): rect is CameraRect {
  if (!rect) return false
  return [rect.left, rect.top, rect.right, rect.bottom, rect.width, rect.height].every(Number.isFinite)
    && rect.width > 0
    && rect.height > 0
    && rect.right > rect.left
    && rect.bottom > rect.top
}

function rectSize(rect: CameraRect): RectSize | undefined {
  const width = rect.right - rect.left
  const height = rect.bottom - rect.top
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return { width, height }
}

function intersectRects(mapRect: CameraRect, drawerRect: CameraRect): RectOverlap | undefined {
  const left = Math.max(mapRect.left, drawerRect.left)
  const top = Math.max(mapRect.top, drawerRect.top)
  const right = Math.min(mapRect.right, drawerRect.right)
  const bottom = Math.min(mapRect.bottom, drawerRect.bottom)
  const width = right - left
  const height = bottom - top
  if (width <= 0 || height <= 0) return undefined
  return { left, top, right, bottom, width, height }
}

function clampPaddingPair(start: number, end: number, size: number, minVisible: number): [number, number] {
  const availablePadding = Math.max(0, size - Math.min(size, minVisible))
  const safeStart = Math.min(nonNegativeFinite(start, 0), availablePadding)
  const safeEnd = Math.min(nonNegativeFinite(end, 0), Math.max(0, availablePadding - safeStart))
  return [safeStart, safeEnd]
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value!) : fallback
}

function boundedFinite(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value!)) : fallback
}
