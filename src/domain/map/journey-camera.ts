export type MapCameraState = {
  center: [number, number]
  zoom: number
}

export type MapCameraAdapter = {
  getCenter: () => { lat: number; lng: number }
  getZoom: () => number
  setView: (center: [number, number], zoom: number, options: { animate: false }) => unknown
}

export type JourneyPreviewCamera = {
  fitCamera: boolean
  restoreCamera: boolean
}

export function captureMapCamera(map: MapCameraAdapter): MapCameraState {
  const center = map.getCenter()
  return { center: [center.lat, center.lng], zoom: map.getZoom() }
}

export function restoreMapCamera(map: MapCameraAdapter, state: MapCameraState): void {
  map.setView(state.center, state.zoom, { animate: false })
}

export function journeyPreviewCamera(kind: 'initial' | 'selection' | 'return' | 'rerender'): JourneyPreviewCamera {
  if (kind === 'return') return { fitCamera: false, restoreCamera: true }
  if (kind === 'initial' || kind === 'selection') return { fitCamera: true, restoreCamera: false }
  return { fitCamera: false, restoreCamera: false }
}
