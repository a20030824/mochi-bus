import type { RouteEtaResponse, RouteEtaStop } from '../../src/domain/route-page-detail'
import { isTdxTokenRejectedError, requestMochiJson } from '../tdx/api-client'
import { parseRouteEtaResponse } from './contract'
import { createVisibleRefreshController, type VisibleRefreshResult } from './refresh-controller'

const ROUTE_DEGRADED_REFRESH_MS = 2 * 60_000
const ROUTE_QUOTA_REFRESH_MS = 5 * 60_000

const routePage = document.querySelector<HTMLElement>('.route-page')
if (routePage) {
  prepareSelectedEta(routePage)
  const selectedStopUid = new URLSearchParams(window.location.search).get('stopUid')
  const refreshController = createVisibleRefreshController({
    refresh: (signal) => refreshRouteEta(routePage, selectedStopUid, signal),
    isVisible: () => document.visibilityState === 'visible',
  })
  document.addEventListener('visibilitychange', () => {
    void refreshController.visibilityChanged()
  })
  void refreshController.start()
}

async function refreshRouteEta(
  page: HTMLElement,
  selectedStopUid: string | null,
  signal: AbortSignal,
): Promise<VisibleRefreshResult> {
  try {
    const suffix = window.location.search || ''
    const raw = await requestMochiJson<unknown>(
      '/api/v1/route-eta' + suffix,
      { cache: 'no-store', signal },
      { authenticated: true, fallback: '即時到站讀取失敗' },
    )
    const response = parseRouteEtaResponse(raw)
    applyRouteEta(page, response, selectedStopUid)
    return refreshResultFor(response)
  } catch (error) {
    if (isAbortError(error)) return

    clearRouteEta(page)
    const tokenRejected = isTdxTokenRejectedError(error)
    setSelectedStatus(page, tokenRejected ? '憑證失效' : '即時未更新')
    console.error(JSON.stringify({ message: 'route_eta_client_failed' }))
    if (tokenRejected) return 'stop'
    return { nextDelayMs: ROUTE_DEGRADED_REFRESH_MS }
  }
}

function refreshResultFor(response: RouteEtaResponse): VisibleRefreshResult {
  if (response.eta.kind !== 'unavailable') return
  return {
    nextDelayMs: response.eta.warning === 'tdx-quota'
      ? ROUTE_QUOTA_REFRESH_MS
      : ROUTE_DEGRADED_REFRESH_MS,
  }
}

function prepareSelectedEta(page: HTMLElement): void {
  const etaNodes = page.querySelectorAll<HTMLElement>('.route-stop.selected .route-eta')
  etaNodes.forEach((etaNode) => {
    etaNode.setAttribute('aria-live', 'polite')
    etaNode.setAttribute('aria-atomic', 'true')
  })
}

function applyRouteEta(
  page: HTMLElement,
  response: RouteEtaResponse,
  selectedStopUid: string | null,
): void {
  const rows = Array.from(page.querySelectorAll<HTMLLIElement>('.route-stop'))
  if (rows.length !== response.stops.length) {
    throw new Error('Route ETA station count does not match the rendered timeline')
  }
  if (!rows.some((row) => row.classList.contains('selected'))) {
    throw new Error('Route ETA timeline has no selected station')
  }

  const targets = rows.map((row, index) => validateStopTarget(
    row,
    response.stops[index],
    selectedStopUid,
  ))
  targets.forEach(({ etaNode, stop }) => updateStopEta(etaNode, stop))
}

function validateStopTarget(
  row: HTMLLIElement,
  stop: RouteEtaStop | undefined,
  selectedStopUid: string | null,
): { etaNode: HTMLElement; stop: RouteEtaStop } {
  const nameNode = row.querySelector<HTMLElement>('strong')
  const etaNode = row.querySelector<HTMLElement>('.route-eta')
  const selectedIdentityMismatch = row.classList.contains('selected')
    && selectedStopUid !== null
    && stop?.stopUid !== selectedStopUid
  if (!stop
    || !nameNode
    || !etaNode
    || nameNode.textContent?.trim() !== stop.stopName
    || selectedIdentityMismatch) {
    throw new Error('Route ETA station order does not match the rendered timeline')
  }
  return { etaNode, stop }
}

function updateStopEta(etaNode: HTMLElement, stop: RouteEtaStop): void {
  etaNode.textContent = stop.etaLabel ?? ''
  etaNode.classList.remove('live', 'urgent', 'muted')
  etaNode.classList.add(stop.etaTone)
}

function clearRouteEta(page: HTMLElement): void {
  page.querySelectorAll<HTMLElement>('.route-eta').forEach((etaNode) => {
    etaNode.textContent = ''
    etaNode.classList.remove('live', 'urgent', 'muted')
    etaNode.classList.add('muted')
  })
}

function setSelectedStatus(page: HTMLElement, label: string): void {
  page.querySelectorAll<HTMLElement>('.route-stop.selected .route-eta').forEach((etaNode) => {
    etaNode.textContent = label
    etaNode.classList.remove('live', 'urgent')
    etaNode.classList.add('muted')
  })
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object'
    && error !== null
    && 'name' in error
    && (error as { name?: unknown }).name === 'AbortError'
}
