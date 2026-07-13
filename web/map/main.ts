import L from 'leaflet'
import { calculateCameraPadding, type CameraRect } from '../../src/domain/map/camera-padding'

const mapNode = requiredElement('map')
const drawer = requiredElement('map-drawer')
const originalFitBounds = L.Map.prototype.fitBounds

type PendingFitBounds = {
  map: L.Map
  bounds: L.LatLngBoundsExpression
  options: L.FitBoundsOptions
}

let pendingDrawerFit: PendingFitBounds | undefined

// The route/variant views request their camera before replacing the drawer contents.
// Keep that request synchronous, then execute it immediately after replaceChildren so
// the rectangle reflects the drawer that will actually cover the map. Journey previews
// already render the drawer before fitting and retain their existing maxZoom: 16.
L.Map.prototype.fitBounds = function (
  this: L.Map,
  bounds: L.LatLngBoundsExpression,
  options: L.FitBoundsOptions = {},
): L.Map {
  if (options.maxZoom !== 16) {
    pendingDrawerFit = { map: this, bounds, options }
    return this
  }
  return fitBoundsWithCurrentDrawer(this, bounds, options)
} as L.Map['fitBounds']

const replaceDrawerChildren = drawer.replaceChildren.bind(drawer)
Object.defineProperty(drawer, 'replaceChildren', {
  configurable: true,
  value: (...nodes: Array<Node | string>) => {
    replaceDrawerChildren(...nodes)
    flushPendingDrawerFit()
  },
})

function flushPendingDrawerFit() {
  const pending = pendingDrawerFit
  pendingDrawerFit = undefined
  if (!pending) return
  fitBoundsWithCurrentDrawer(pending.map, pending.bounds, pending.options)
}

function fitBoundsWithCurrentDrawer(
  map: L.Map,
  bounds: L.LatLngBoundsExpression,
  options: L.FitBoundsOptions,
): L.Map {
  return originalFitBounds.call(map, bounds, {
    ...options,
    ...drawerAwareCameraPadding(),
  })
}

function drawerAwareCameraPadding() {
  return calculateCameraPadding(readCameraRect(mapNode), readCameraRect(drawer))
}

function readCameraRect(element: HTMLElement): CameraRect {
  const { left, top, right, bottom, width, height } = element.getBoundingClientRect()
  return { left, top, right, bottom, width, height }
}

function requiredElement<T extends HTMLElement = HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing #${id}`)
  return element as T
}

void import('./main-app')
