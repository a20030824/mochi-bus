import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Layer, Tooltip } from 'leaflet'
import { bindTextTooltip, setTextTooltip, tooltipText } from './leaflet-tooltip'

describe('Leaflet text tooltips', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('assigns untrusted labels through textContent', () => {
    const element = { textContent: '' }
    const createElement = vi.fn(() => element)
    vi.stubGlobal('document', { createElement })

    const content = tooltipText('<img src=x onerror=alert(1)>')

    expect(createElement).toHaveBeenCalledWith('span')
    expect(content.textContent).toBe('<img src=x onerror=alert(1)>')
    expect(element).not.toHaveProperty('innerHTML')
  })

  it('uses DOM nodes for initial binding and later updates', () => {
    vi.stubGlobal('document', { createElement: () => ({ textContent: '' }) })
    const layer = { bindTooltip: vi.fn() } as unknown as Layer
    const tooltip = { setContent: vi.fn().mockReturnThis() } as unknown as Tooltip

    expect(bindTextTooltip(layer, '<b>route</b>')).toBe(layer)
    expect(layer.bindTooltip).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: '<b>route</b>' }),
      undefined,
    )

    expect(setTextTooltip(tooltip, '<i>stop</i>')).toBe(tooltip)
    expect(tooltip.setContent).toHaveBeenCalledWith(
      expect.objectContaining({ textContent: '<i>stop</i>' }),
    )
  })
})
