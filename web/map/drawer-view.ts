import { attachScrollFade } from '../lib/scroll-fade'

export type DrawerScrollableMode = 'map-list' | 'results' | 'timetable'

export type DrawerView =
  | {
      mode: 'compact'
      content: readonly Node[]
    }
  | {
      mode: DrawerScrollableMode
      header: readonly Node[]
      content: readonly Node[]
      footer?: readonly Node[]
    }

export type DrawerViewSession = {
  readonly signal: AbortSignal
  readonly scrollRegion?: HTMLDivElement
  onDispose(cleanup: () => void): void
}

export type DrawerRenderer = {
  render(view: DrawerView): DrawerViewSession
  dispose(): void
}

export function createDrawerRenderer(drawer: HTMLElement): DrawerRenderer {
  let disposeCurrentView: (() => void) | undefined

  const dispose = () => {
    disposeCurrentView?.()
    disposeCurrentView = undefined
  }

  const render = (view: DrawerView): DrawerViewSession => {
    dispose()

    const abortController = new AbortController()
    const cleanups: Array<() => void> = []
    let active = true
    let scrollRegion: HTMLDivElement | undefined

    drawer.dataset.mode = view.mode
    drawer.scrollTop = 0
    drawer.replaceChildren()

    if (view.mode === 'compact') {
      drawer.dataset.scrollable = 'false'
      appendNodes(drawer, view.content)
    } else {
      drawer.dataset.scrollable = 'true'
      const shell = document.createElement('div')
      shell.className = 'drawer-scroll-shell'
      scrollRegion = document.createElement('div')
      scrollRegion.className = 'drawer-scroll-region'
      appendNodes(scrollRegion, view.content)

      const fade = document.createElement('div')
      fade.className = 'drawer-scroll-fade'
      fade.setAttribute('aria-hidden', 'true')
      shell.appendChild(scrollRegion)
      shell.appendChild(fade)
      appendNodes(drawer, view.header)
      drawer.appendChild(shell)
      appendNodes(drawer, view.footer ?? [])

      cleanups.push(attachScrollFade(scrollRegion))
    }

    const disposeView = () => {
      if (!active) return
      active = false
      abortController.abort()
      for (const cleanup of cleanups.splice(0).reverse()) cleanup()
    }
    disposeCurrentView = disposeView

    return {
      signal: abortController.signal,
      scrollRegion,
      onDispose(cleanup) {
        if (active) cleanups.push(cleanup)
        else cleanup()
      },
    }
  }

  return { render, dispose }
}

function appendNodes(parent: Node, nodes: readonly Node[]) {
  for (const node of nodes) parent.appendChild(node)
}
