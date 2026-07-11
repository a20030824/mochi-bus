import type { LonLat } from './network-pick'

// 全路網鳥瞰不需要單一路線的完整精度(現有 route 端點約 8 m 已經很細);
// 用 Douglas-Peucker 把每條線簡化到指定公尺容差,城市級 payload/parse/index
// 成本可以下降一個數量級,但仍保留看得出路線走向的形狀。
// 距離換算跟 network-pick.ts 同一套做法:經度先乘 cos(參考緯度) 校正成
// 等向平面,城市範圍內的誤差可以忽略。
const METERS_PER_DEGREE_LATITUDE = 111_320

export function simplifyLine(points: readonly LonLat[], toleranceMeters: number): LonLat[] {
  if (points.length <= 2 || toleranceMeters <= 0) return [...points]
  const cosine = Math.cos(points[0][1] * Math.PI / 180)
  const toleranceDegrees = toleranceMeters / METERS_PER_DEGREE_LATITUDE
  const keep = new Uint8Array(points.length)
  keep[0] = 1
  keep[points.length - 1] = 1
  simplifyRange(points, 0, points.length - 1, toleranceDegrees, cosine, keep)
  return points.filter((_point, index) => keep[index] === 1)
}

function simplifyRange(
  points: readonly LonLat[],
  startIndex: number,
  endIndex: number,
  toleranceDegrees: number,
  cosine: number,
  keep: Uint8Array,
): void {
  if (endIndex <= startIndex + 1) return
  let maxDistance = 0
  let maxIndex = -1
  for (let index = startIndex + 1; index < endIndex; index += 1) {
    const distance = perpendicularDistance(points[startIndex], points[endIndex], points[index], cosine)
    if (distance > maxDistance) {
      maxDistance = distance
      maxIndex = index
    }
  }
  if (maxIndex < 0 || maxDistance <= toleranceDegrees) return
  keep[maxIndex] = 1
  simplifyRange(points, startIndex, maxIndex, toleranceDegrees, cosine, keep)
  simplifyRange(points, maxIndex, endIndex, toleranceDegrees, cosine, keep)
}

// 點到「起訖點所在直線」的垂直距離(非線段),是經典 Douglas-Peucker 的定義;
// 回傳單位是 cosine 校正後的度數,跟 toleranceDegrees 同單位可以直接比較。
function perpendicularDistance(start: LonLat, end: LonLat, point: LonLat, cosine: number): number {
  const x1 = start[0] * cosine
  const y1 = start[1]
  const x2 = end[0] * cosine
  const y2 = end[1]
  const px = point[0] * cosine
  const py = point[1]
  const dx = x2 - x1
  const dy = y2 - y1
  const lineLength = Math.hypot(dx, dy)
  if (lineLength === 0) return Math.hypot(px - x1, py - y1)
  return Math.abs((px - x1) * dy - (py - y1) * dx) / lineLength
}
