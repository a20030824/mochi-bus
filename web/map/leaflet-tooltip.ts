import type { Layer, Tooltip, TooltipOptions } from 'leaflet'

export function tooltipText(text: string): HTMLSpanElement {
  const content = document.createElement('span')
  content.textContent = text
  return content
}

export function bindTextTooltip<T extends Layer>(layer: T, text: string, options?: TooltipOptions): T {
  layer.bindTooltip(tooltipText(text), options)
  return layer
}

export function setTextTooltip(tooltip: Tooltip, text: string): Tooltip {
  return tooltip.setContent(tooltipText(text))
}
