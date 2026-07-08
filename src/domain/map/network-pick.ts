// 全路網為了效能整層畫成 non-interactive canvas:Leaflet 的 canvas renderer
// 每次 mousemove 都會對 renderer 裡「每一條」路徑做 hit-test(數百條線 × 每條
// 數百個線段),桌機游標一動就是十萬級的幾何運算,hover 樣式變化又觸發整張
// canvas 重繪,所以會卡;手機沒有 mousemove 才倖免。
// 命中改由這裡回答:載入路網時建一次均勻網格索引,之後每次查詢只掃游標
// 附近的格子。
// 距離一律以「緯度度數」為單位(經度先乘 cos(參考緯度) 校正成等向),
// 呼叫端把像素容差換算成緯度度數傳進來,索引就完全不用管 zoom。

export type LonLat = [number, number]

export type NetworkPick =
  | { kind: 'place'; placeIndex: number }
  | { kind: 'route'; routeIndex: number }

export type NetworkIndex = {
  cellSize: number
  cosine: number
  cells: Map<string, { segments: number[]; places: number[] }>
  // 線段與站點攤平成 typed array,查詢熱路徑不追物件參照
  segments: Float64Array
  segmentRoute: Int32Array
  places: Float64Array
}

// cellSize 以緯度度數計,0.004 約 440 公尺:城市 zoom 下常用容差(幾~十幾
// 像素)最多掃 3×3 格,拉遠到 zoom 9 也只是幾十格。
export function buildNetworkIndex(
  routes: LonLat[][],
  places: LonLat[],
  cellSize = 0.004,
): NetworkIndex {
  const reference = routes.find((line) => line.length)?.[0] ?? places[0]
  const cosine = reference ? Math.cos(reference[1] * Math.PI / 180) : 1
  const cells = new Map<string, { segments: number[]; places: number[] }>()
  const cellAt = (cellX: number, cellY: number) => {
    const key = `${cellX},${cellY}`
    let cell = cells.get(key)
    if (!cell) {
      cell = { segments: [], places: [] }
      cells.set(key, cell)
    }
    return cell
  }

  let segmentCount = 0
  for (const line of routes) segmentCount += Math.max(0, line.length - 1)
  const segments = new Float64Array(segmentCount * 4)
  const segmentRoute = new Int32Array(segmentCount)
  let segmentIndex = 0
  routes.forEach((line, routeIndex) => {
    for (let index = 0; index + 1 < line.length; index += 1) {
      const x1 = line[index][0] * cosine
      const y1 = line[index][1]
      const x2 = line[index + 1][0] * cosine
      const y2 = line[index + 1][1]
      segments[segmentIndex * 4] = x1
      segments[segmentIndex * 4 + 1] = y1
      segments[segmentIndex * 4 + 2] = x2
      segments[segmentIndex * 4 + 3] = y2
      segmentRoute[segmentIndex] = routeIndex
      // 線段登記到 bbox 蓋到的每一格,查詢時看單格就不會漏斜跨的線段
      const minCellX = Math.floor(Math.min(x1, x2) / cellSize)
      const maxCellX = Math.floor(Math.max(x1, x2) / cellSize)
      const minCellY = Math.floor(Math.min(y1, y2) / cellSize)
      const maxCellY = Math.floor(Math.max(y1, y2) / cellSize)
      for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
        for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
          cellAt(cellX, cellY).segments.push(segmentIndex)
        }
      }
      segmentIndex += 1
    }
  })

  const placeCoordinates = new Float64Array(places.length * 2)
  places.forEach((place, placeIndex) => {
    const x = place[0] * cosine
    const y = place[1]
    placeCoordinates[placeIndex * 2] = x
    placeCoordinates[placeIndex * 2 + 1] = y
    cellAt(Math.floor(x / cellSize), Math.floor(y / cellSize)).places.push(placeIndex)
  })

  return { cellSize, cosine, cells, segments, segmentRoute, places: placeCoordinates }
}

// 站點絕對優先於路線:小圓點畫在線之上、也是更明確的意圖,
// 容差內有站點就回站點,即使某條線離游標更近。
export function pickNetwork(
  index: NetworkIndex,
  point: LonLat,
  routeTolerance: number,
  placeTolerance: number,
): NetworkPick | undefined {
  const pointX = point[0] * index.cosine
  const pointY = point[1]
  const radius = Math.max(routeTolerance, placeTolerance)
  const minCellX = Math.floor((pointX - radius) / index.cellSize)
  const maxCellX = Math.floor((pointX + radius) / index.cellSize)
  const minCellY = Math.floor((pointY - radius) / index.cellSize)
  const maxCellY = Math.floor((pointY + radius) / index.cellSize)

  let bestPlace = -1
  let bestPlaceDistance = placeTolerance * placeTolerance
  let bestRoute = -1
  let bestRouteDistance = routeTolerance * routeTolerance
  for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
    for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
      const cell = index.cells.get(`${cellX},${cellY}`)
      if (!cell) continue
      for (const placeIndex of cell.places) {
        const deltaX = index.places[placeIndex * 2] - pointX
        const deltaY = index.places[placeIndex * 2 + 1] - pointY
        const distance = deltaX * deltaX + deltaY * deltaY
        if (distance <= bestPlaceDistance) {
          bestPlaceDistance = distance
          bestPlace = placeIndex
        }
      }
      for (const segmentIndex of cell.segments) {
        const distance = segmentDistanceSquared(pointX, pointY, index.segments, segmentIndex * 4)
        if (distance <= bestRouteDistance) {
          bestRouteDistance = distance
          bestRoute = index.segmentRoute[segmentIndex]
        }
      }
    }
  }
  if (bestPlace >= 0) return { kind: 'place', placeIndex: bestPlace }
  if (bestRoute >= 0) return { kind: 'route', routeIndex: bestRoute }
  return undefined
}

function segmentDistanceSquared(
  pointX: number,
  pointY: number,
  segments: Float64Array,
  offset: number,
): number {
  const x1 = segments[offset]
  const y1 = segments[offset + 1]
  const deltaX = segments[offset + 2] - x1
  const deltaY = segments[offset + 3] - y1
  const lengthSquared = deltaX * deltaX + deltaY * deltaY
  const t = lengthSquared === 0
    ? 0
    : Math.min(1, Math.max(0, ((pointX - x1) * deltaX + (pointY - y1) * deltaY) / lengthSquared))
  const nearestX = x1 + t * deltaX - pointX
  const nearestY = y1 + t * deltaY - pointY
  return nearestX * nearestX + nearestY * nearestY
}
