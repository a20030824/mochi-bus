import type { RouteEtaResponse, RouteEtaStop } from '../../src/domain/route-page-detail'
import { isTdxTokenRejectedError, requestMochiJson } from '../tdx/api-client'
import { parseRouteEtaResponse } from './contract'
import { createVisibleRefreshController } from './refresh-controller'

const routePage = document.querySelector<HTMLElement>('.route-page')
if (routePage) {
  prepareSelectedEta(routePage)
  const refreshController = createVisibleRefreshController({
    refresh: () => refreshRouteEta(routePage),
    isVisible: () => document.visibilityState === 'visible',
  })
  document.addEventListener('visibilitychange', () => {
    void refreshController.visibilityChanged()
  })
  void refreshController.start()
}

async function refreshRouteEta(page: HTMLElement): Promise<void> {
  try {
    const suffix = window.location.search || ''
    const raw = await requestMochiJson<unknown>(
      '/api/v1/route-eta' + suffix,
      { cache: 'no-store' },
      { authenticated: true, fallback: '即時到站讀取失敗' },
    )
    applyRouteEta(page, parseRouteEtaResponse(raw))
  } catch (error) {
    setSelectedStatus(page, isTdxTokenRejectedError(error) ? '憑證失效' : '即時未更新')
    console.error(JSON.stringify({ message: 'route_eta_client_failed' }))
  }
}

function prepareSelectedEta(page: HTMLElement): void {
  const etaNode = page.querySelector<HTMLElement>('.route-stop.selected .route-eta')
  if (!etaNode) return
  etaNode.setAttribute('aria-live', 'polite')
  etaNode.setAttribute('aria-atomic', 'true')
}

function applyRouteEta(page: HTMLElement, response: RouteEtaResponse): void {
  const rows = Array.from(page.querySelectorAll<HTMLLIElement>('.route-stop'))
  if (rows.length !== response.stops.length) {
    throw new Error('Route ETA station count does not match the rendered timeline')
  }

  const targets = rows.map((row, index) => validateStopTarget(row, response.stops[index]))
  targets.forEach(({ etaNode, stop }) => updateStopEta(etaNode, stop))
}

function validateStopTarget(
  row: HTMLLIElement,
  stop: RouteEtaStop | undefined,
): { etaNode: HTMLElement; stop: RouteEtaStop } {
  const nameNode = row.querySelector<HTMLElement>('strong')
  const etaNode = row.querySelector<HTMLElement>('.route-eta')
  if (!stop || !nameNode || !etaNode || nameNode.textContent?.trim() !== stop.stopName) {
    throw new Error('Route ETA station order does not match the rendered timeline')
  }
  return { etaNode, stop }
}

function updateStopEta(etaNode: HTMLElement, stop: RouteEtaStop): void {
  etaNode.textContent = stop.etaLabel ?? ''
  etaNode.classList.remove('live', 'urgent', 'muted')
  etaNode.classList.add(stop.etaTone)
}

function setSelectedStatus(page: HTMLElement, label: string): void {
  const etaNode = page.querySelector<HTMLElement>('.route-stop.selected .route-eta')
  if (!etaNode) return
  etaNode.textContent = label
  etaNode.classList.remove('live', 'urgent')
  etaNode.classList.add('muted')
}
