import {
  activeBoardId,
  migrateBoards,
  setActiveCity,
  syncActiveBoard,
  writeBoards,
  type FavoriteBoard,
  type FavoriteBus,
} from '../boards/store'
import { requestMochiJson } from '../tdx/api-client'

type EtaBootstrap = {
  initialBoard: FavoriteBoard
  useLocalBoard: boolean
  tdxWarningMessages: Record<string, string>
}

type EtaData = {
  label?: string
  estimateSeconds?: number | null
  source?: string
  fetchedAt?: string
  dataTime?: string | null
  stale?: boolean
  warning?: string
}

type StopGroup = {
  direction: 0 | 1 | 2
  label: string
  subRouteUid?: string
  stops?: Array<{ stopUid: string; stopName: string; routeUid?: string; subRouteUid?: string }>
}

type PlaceRoute = {
  routeName: string
  variantKey: string
  direction: 0 | 1 | 2
  label: string
  routeUid: string
  subRouteUid?: string
  stopUid: string
  stopName: string
  estimateSeconds: number | null
  etaLabel: string
  source?: string
}

type RefreshResponse = {
  bus: FavoriteBus
  data?: EtaData
  failed?: boolean
}

function requiredElement<T extends globalThis.Element>(selector: string): T {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`ETA page is missing required element: ${selector}`)
  return element as T
}

function readBootstrap(): EtaBootstrap {
  const node = requiredElement<HTMLScriptElement>('#eta-bootstrap')
  const raw = node.textContent
  if (!raw) throw new Error('ETA bootstrap is empty')

  let value: unknown
  try {
    value = JSON.parse(raw) as unknown
  } catch {
    throw new Error('ETA bootstrap is not valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('ETA bootstrap must be an object')
  }
  const record = value as Record<string, unknown>
  const initialBoard = record.initialBoard
  if (!initialBoard || typeof initialBoard !== 'object' || Array.isArray(initialBoard)) {
    throw new Error('ETA bootstrap initialBoard must be an object')
  }
  const buses = (initialBoard as Record<string, unknown>).buses
  if (!Array.isArray(buses)) throw new Error('ETA bootstrap initialBoard.buses must be an array')
  if (typeof record.useLocalBoard !== 'boolean') throw new Error('ETA bootstrap useLocalBoard must be a boolean')
  const warnings = record.tdxWarningMessages
  if (!warnings || typeof warnings !== 'object' || Array.isArray(warnings)) {
    throw new Error('ETA bootstrap tdxWarningMessages must be an object')
  }
  return {
    initialBoard: initialBoard as FavoriteBoard,
    useLocalBoard: record.useLocalBoard,
    tdxWarningMessages: warnings as Record<string, string>,
  }
}

const { initialBoard, useLocalBoard, tdxWarningMessages } = readBootstrap()
let currentBoard = initialBoard
// 示範模式:使用者還沒有任何常用站牌,封面顯示示範站牌與導引,不寫入本機資料。
let demoBoard = false
const listNode = requiredElement<HTMLDivElement>('#bus-list')
const titleNode = requiredElement<HTMLHeadingElement>('#board-title')
const noticeNode = requiredElement<HTMLParagraphElement>('#notice')
const updatedNode = requiredElement<HTMLSpanElement>('#updated')
const refreshButton = requiredElement<HTMLButtonElement>('#refresh')
const onboardNode = requiredElement<HTMLDivElement>('#onboard')
const onboardSignNode = requiredElement<HTMLDivElement>('#onboard-sign')
const topActionLinks = document.querySelectorAll<HTMLAnchorElement>('.top-actions a')
const mapLink = topActionLinks[0]
if (!mapLink) throw new Error('ETA page is missing the map link')
mapLink.removeAttribute('style')
if (topActionLinks[1]) topActionLinks[1].remove()

function paramsFor(bus: FavoriteBus): URLSearchParams {
  const params = new URLSearchParams({ city: bus.city || currentBoard.city || '', route: bus.routeName, direction: String(bus.direction) })
  if (bus.stopName) params.set('stop', bus.stopName)
  if (bus.stopUid) params.set('stopUid', bus.stopUid)
  if (bus.routeUid) params.set('routeUid', bus.routeUid)
  if (bus.subRouteUid) params.set('subRouteUid', bus.subRouteUid)
  return params
}

function routeLink(bus: FavoriteBus): string {
  if (bus.stopName && bus.stopUid) return '/route?' + paramsFor(bus)
  return '#'
}

function makeRow(bus: FavoriteBus, data?: EtaData, failed = false): HTMLAnchorElement {
  const link = document.createElement('a')
  link.className = 'bus-row'
  link.href = routeLink(bus)
  const routeCopy = document.createElement('span')
  routeCopy.className = 'bus-route-copy'
  const route = document.createElement('strong')
  route.className = 'bus-name'
  route.textContent = bus.routeName
  const direction = document.createElement('small')
  direction.className = 'bus-direction'
  direction.textContent = bus.directionLabel || ''
  direction.hidden = !bus.directionLabel
  routeCopy.replaceChildren(route)
  const eta = document.createElement('span')
  eta.className = 'bus-eta'
  eta.textContent = failed ? '暫無資料' : data?.label || '更新中'
  if (!failed && data?.source === 'stale-realtime') {
    const freshness = document.createElement('small')
    freshness.textContent = '稍早'
    freshness.style.cssText = 'margin-left:7px;color:#777066;font-size:11px;font-weight:750;letter-spacing:0'
    eta.appendChild(freshness)
  }
  link.replaceChildren(routeCopy, eta, direction)
  return link
}

async function fillDirectionLabel(bus: FavoriteBus): Promise<void> {
  if (bus.directionLabel) return
  try {
    const params = new URLSearchParams({ city: bus.city || '', route: bus.routeName })
    if (bus.routeUid) params.set('routeUid', bus.routeUid)
    const body = await requestMochiJson<{ groups?: StopGroup[] }>(
      '/api/v1/stops?' + params,
      {},
      { authenticated: true },
    )
    const group = body.groups?.find((candidate) =>
      candidate.direction === bus.direction
      && (!bus.subRouteUid || candidate.subRouteUid === bus.subRouteUid)
      && candidate.stops?.some((stop) => stop.stopUid === bus.stopUid))
    if (group?.label) bus.directionLabel = group.label
  } catch {}
}

let placeRoutesPromise: Promise<{ routes?: PlaceRoute[] }> | undefined
async function repairBusFromPlace(bus: FavoriteBus): Promise<boolean> {
  // 地圖舊收藏即使已有站牌，也要補齊 patternId，避免同路線變體誤配。
  if (bus.stopName && bus.stopUid && (!currentBoard.placeId || bus.patternId)) return true
  const city = bus.city || currentBoard.city
  if (!city) return false
  try {
    if (currentBoard.placeId) {
      // 失敗的 promise 不能快取,否則一次網路失敗會讓修復永遠癱瘓到重新整理為止。
      placeRoutesPromise ||= requestMochiJson<{ routes?: PlaceRoute[] }>(
        '/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/routes?city=' + encodeURIComponent(city),
      )
        .catch((error: unknown) => { placeRoutesPromise = undefined; throw error })
      const body = await placeRoutesPromise
      const candidates = (body.routes || []).filter((route) =>
        route.routeName === bus.routeName
        && route.direction === bus.direction
        && (!bus.routeUid || route.routeUid === bus.routeUid)
        && (!bus.subRouteUid || !route.subRouteUid || route.subRouteUid === bus.subRouteUid)
        && (!bus.patternId || route.variantKey === bus.patternId))
      const labeled = bus.directionLabel
        ? candidates.filter((route) => route.label === bus.directionLabel)
        : candidates
      const match = labeled.length === 1 ? labeled[0] : undefined
      if (match) {
        bus.city = city
        bus.routeUid = match.routeUid
        bus.subRouteUid = match.subRouteUid
        bus.patternId = match.variantKey
        delete bus.identityStatus
        bus.stopName = match.stopName
        bus.stopUid = match.stopUid
        bus.directionLabel = match.label
        return true
      }
    }
    const params = new URLSearchParams({ city, route: bus.routeName })
    if (bus.routeUid) params.set('routeUid', bus.routeUid)
    const body = await requestMochiJson<{ groups?: StopGroup[] }>(
      '/api/v1/stops?' + params,
      {},
      { authenticated: true },
    )
    const groups = (body.groups || []).filter((group) =>
      group.direction === bus.direction
      && (!bus.directionLabel || group.label === bus.directionLabel))
    const matches = groups.flatMap((group) => (group.stops || [])
      .filter((stop) => stop.stopName === currentBoard.title)
      .map((stop) => ({ group, stop })))
    if (matches.length !== 1) return false
    bus.city = city
    bus.routeUid = matches[0].stop.routeUid || bus.routeUid
    bus.subRouteUid = matches[0].stop.subRouteUid || bus.subRouteUid
    delete bus.identityStatus
    bus.stopName = matches[0].stop.stopName
    bus.stopUid = matches[0].stop.stopUid
    bus.directionLabel = matches[0].group.label
    return true
  } catch { return false }
}

async function loadPlaceArrivals(): Promise<PlaceRoute[] | null> {
  const city = currentBoard.city || currentBoard.buses[0]?.city
  if (!city || !currentBoard.placeId) return null
  try {
    const params = new URLSearchParams({ city })
    const focus = currentBoard.buses[0]
    if (focus?.stopUid) params.set('focusStopUid', focus.stopUid)
    if (focus?.subRouteUid) params.set('focusSubRouteUid', focus.subRouteUid)
    if (focus && (focus.direction === 0 || focus.direction === 1 || focus.direction === 2)) {
      params.set('focusDirection', String(focus.direction))
    }
    const body = await requestMochiJson<{ routes?: PlaceRoute[] }>(
      '/api/v1/map/place/' + encodeURIComponent(currentBoard.placeId) + '/arrivals?' + params,
      { cache: 'no-store' },
      { authenticated: true },
    )
    return Array.isArray(body.routes) ? body.routes : null
  } catch { return null }
}

async function refreshBoard(): Promise<void> {
  // 定時器與 visibilitychange 可能同時觸發,更新中就別再疊一輪。
  if (refreshButton.disabled) return
  refreshButton.disabled = true
  refreshButton.textContent = '更新中'
  noticeNode.textContent = ''
  const placeArrivals = await loadPlaceArrivals()
  const responses: RefreshResponse[] = await Promise.all(currentBoard.buses.map(async (bus): Promise<RefreshResponse> => {
    const repaired = await repairBusFromPlace(bus)
    // 沒有站牌識別就不打 ETA,避免必然的 400。
    if (!repaired || (!bus.stopUid && !bus.stopName)) return { bus, failed: true }
    await fillDirectionLabel(bus)
    if (placeArrivals) {
      const arrival = placeArrivals.find((route) =>
        route.routeUid === bus.routeUid
        && route.stopUid === bus.stopUid
        && route.direction === bus.direction
        && (!bus.subRouteUid || !route.subRouteUid || route.subRouteUid === bus.subRouteUid)
        && (!bus.patternId || route.variantKey === bus.patternId))
      if (!arrival) return { bus, failed: true }
      return { bus, data: {
        label: arrival.etaLabel,
        estimateSeconds: arrival.estimateSeconds,
        source: arrival.source,
        fetchedAt: new Date().toISOString(),
        dataTime: null,
        stale: false,
      }}
    }
    try {
      const body = await requestMochiJson<EtaData>(
        '/api/v1/eta?' + paramsFor(bus),
        { cache: 'no-store' },
        { authenticated: true },
      )
      return { bus, data: body }
    } catch { return { bus, failed: true } }
  }))
  responses.sort((a, b) => {
    const aEta = typeof a.data?.estimateSeconds === 'number' ? a.data.estimateSeconds : Number.POSITIVE_INFINITY
    const bEta = typeof b.data?.estimateSeconds === 'number' ? b.data.estimateSeconds : Number.POSITIVE_INFINITY
    return aEta - bEta || a.bus.routeName.localeCompare(b.bus.routeName, 'zh-Hant', { numeric: true })
  })
  listNode.replaceChildren(...responses.map((item) => makeRow(item.bus, item.data, item.failed)))
  if (useLocalBoard && !demoBoard) writeBoards(migrateBoards().map((board) => board.id === currentBoard.id ? currentBoard : board))
  const fresh = responses.filter((item) => item.data).map((item) => item.data as EtaData)
  const tdxWarning = ['tdx-quota', 'tdx-rate-limit', 'tdx-unavailable'].find((kind) => fresh.some((item) => item.warning === kind))
  if (tdxWarning) noticeNode.textContent = tdxWarningMessages[tdxWarning]
  else if (fresh.some((item) => item.stale)) noticeNode.textContent = '部分資料有些延遲，以現場站牌為準'
  else if (fresh.some((item) => item.source === 'schedule')) noticeNode.textContent = '部分依時刻表推估，實際到站可能略有出入'
  updatedNode.textContent = fresh[0] ? '資料 ' + new Intl.DateTimeFormat('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(fresh[0].dataTime || fresh[0].fetchedAt || Date.now())) : '暫時無法更新'
  refreshButton.disabled = false
  refreshButton.textContent = '重新整理'
}

if (useLocalBoard) {
  const storedBoards = migrateBoards()
  const boards = storedBoards.filter((board) => !(board.placeId && board.buses?.length > 1 && board.buses.every((bus) => !bus.directionLabel)))
  if (boards.length !== storedBoards.length) {
    writeBoards(boards)
    syncActiveBoard(boards)
  }
  demoBoard = !boards.length
  if (demoBoard) {
    boards.push(initialBoard)
    onboardNode.hidden = false
    onboardSignNode.hidden = false
  }
  const activeId = activeBoardId() || boards[0].id
  currentBoard = boards.find((item) => item.id === activeId) || boards[0]
  titleNode.textContent = demoBoard ? '示範 · ' + currentBoard.title : currentBoard.title
  const firstBus = currentBoard.buses[0]
  const city = currentBoard.city || firstBus?.city
  // 示範看板的城市(config.ts 的預設值)不是使用者選的,不能寫進 activeCity——
  // 否則使用者從沒去過台北,打開地圖卻直接跳台北而不是台灣總覽。
  if (city && !demoBoard) {
    setActiveCity(city)
    const mapParams = new URLSearchParams({ city })
    if (currentBoard.placeId) mapParams.set('place', currentBoard.placeId)
    mapLink.href = '/map?' + mapParams
  }
  if (currentBoard.id !== initialBoard.id || currentBoard.buses.length > 1 || firstBus?.stopUid !== initialBoard.buses[0].stopUid || firstBus?.routeName !== initialBoard.buses[0].routeName || firstBus?.direction !== initialBoard.buses[0].direction) {
    listNode.replaceChildren(...currentBoard.buses.map((bus) => makeRow(bus)))
    void refreshBoard()
  } else void refreshBoard()
}
refreshButton.addEventListener('click', () => { void refreshBoard() })
setInterval(() => { if (!document.hidden) void refreshBoard() }, 30_000)
// 通勤時是「從口袋掏出來瞄一眼」:切回前景那一刻就要是最新的,不能等下一輪定時器。
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshBoard() })
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js')
