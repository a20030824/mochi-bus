import { afterEach, describe, expect, it, vi } from 'vitest'
import { attachScrollFade, hasScrollableContentBelow } from './scroll-fade'

describe('hasScrollableContentBelow', () => {
  it('stays off when all content fits', () => {
    expect(hasScrollableContentBelow(300, 0, 300)).toBe(false)
  })

  it('turns on while content remains below the viewport', () => {
    expect(hasScrollableContentBelow(500, 80, 300)).toBe(true)
  })

  it('stays off at the bottom and within the rounding tolerance', () => {
    expect(hasScrollableContentBelow(500, 200, 300)).toBe(false)
    expect(hasScrollableContentBelow(500, 196, 300)).toBe(false)
  })
})

describe('attachScrollFade', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('disconnects observers and removes the listener and state class', () => {
    const resizeDisconnect = vi.fn()
    const mutationDisconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn()
      disconnect = resizeDisconnect
    })
    vi.stubGlobal('MutationObserver', class {
      observe = vi.fn()
      disconnect = mutationDisconnect
    })

    const classList = {
      toggle: vi.fn(),
      remove: vi.fn(),
    }
    const element = {
      scrollHeight: 500,
      scrollTop: 0,
      clientHeight: 300,
      classList,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as HTMLElement

    const detach = attachScrollFade(element)
    const update = vi.mocked(element.addEventListener).mock.calls[0][1]

    expect(classList.toggle).toHaveBeenCalledWith('scrollable-below', true)
    detach()
    detach()

    expect(element.removeEventListener).toHaveBeenCalledTimes(1)
    expect(element.removeEventListener).toHaveBeenCalledWith('scroll', update)
    expect(resizeDisconnect).toHaveBeenCalledTimes(1)
    expect(mutationDisconnect).toHaveBeenCalledTimes(1)
    expect(classList.remove).toHaveBeenCalledWith('scrollable-below')
  })
})
