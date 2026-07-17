import { etaPresentation, type EtaSource } from '../../src/domain/eta-presentation'

export type EtaRowViewModel = {
  key: string
  href: string
  routeName: string
  directionLabel?: string
  label: string
  estimateSeconds?: number | null
  source?: EtaSource
  stale?: boolean
}

export function createEtaRow(model: EtaRowViewModel): HTMLAnchorElement {
  const row = document.createElement('a')
  row.className = 'bus-row'
  const routeCopy = document.createElement('span')
  routeCopy.className = 'bus-route-copy'
  const route = document.createElement('strong')
  route.className = 'bus-name'
  routeCopy.appendChild(route)
  const eta = document.createElement('span')
  eta.className = 'bus-eta'
  const direction = document.createElement('small')
  direction.className = 'bus-direction'
  row.replaceChildren(routeCopy, eta, direction)
  updateEtaRow(row, model, false)
  return row
}

export function updateEtaRow(
  row: HTMLAnchorElement,
  model: EtaRowViewModel,
  animate = true,
): void {
  row.dataset.busKey = model.key
  row.href = model.href
  const route = requiredChild<HTMLElement>(row, '.bus-name')
  route.textContent = model.routeName
  const direction = requiredChild<HTMLElement>(row, '.bus-direction')
  direction.textContent = model.directionLabel ?? ''
  direction.hidden = !model.directionLabel

  const eta = requiredChild<HTMLElement>(row, '.bus-eta')
  const presentation = etaPresentation(model.label, {
    source: model.source,
    estimateSeconds: model.estimateSeconds,
    stale: model.stale,
  })
  const signature = [
    presentation.prefix,
    presentation.value,
    presentation.suffix,
    presentation.tone,
    presentation.stale ? 'stale' : 'fresh',
    presentation.numeric ? 'numeric' : 'text',
  ].join('|')
  eta.classList.toggle('estimated', presentation.tone === 'estimated')
  eta.classList.toggle('urgent', presentation.tone === 'urgent')
  eta.classList.toggle('non-numeric', !presentation.numeric)
  eta.setAttribute('aria-label', `${model.label}${presentation.stale ? '，稍早資料' : ''}`)
  if (eta.dataset.signature === signature) return

  const nextCopy = etaCopy(presentation)
  const currentCopy = eta.querySelector<HTMLElement>(':scope > .eta-copy:not(.eta-copy-exit)')
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  eta.dataset.signature = signature
  eta.querySelectorAll(':scope > .eta-copy-exit').forEach((node) => node.remove())
  if (!animate || !currentCopy || reduceMotion) {
    eta.replaceChildren(nextCopy)
    return
  }

  currentCopy.classList.add('eta-copy-exit')
  currentCopy.setAttribute('aria-hidden', 'true')
  nextCopy.classList.add('eta-copy-enter')
  eta.appendChild(nextCopy)
  window.setTimeout(() => {
    currentCopy.remove()
    nextCopy.classList.remove('eta-copy-enter')
  }, 220)
}

function etaCopy(presentation: ReturnType<typeof etaPresentation>): HTMLSpanElement {
  const copy = document.createElement('span')
  copy.className = 'eta-copy'
  if (presentation.prefix) {
    const prefix = document.createElement('span')
    prefix.className = 'eta-prefix'
    prefix.textContent = presentation.prefix
    copy.appendChild(prefix)
  }
  const value = document.createElement('span')
  value.className = 'eta-value'
  value.textContent = presentation.value
  copy.appendChild(value)
  if (presentation.suffix) {
    const suffix = document.createElement('span')
    suffix.className = 'eta-suffix'
    suffix.textContent = presentation.suffix
    copy.appendChild(suffix)
  }
  if (presentation.stale) {
    const freshness = document.createElement('small')
    freshness.className = 'eta-freshness'
    freshness.textContent = '稍早'
    copy.appendChild(freshness)
  }
  return copy
}

function requiredChild<T extends globalThis.Element>(row: HTMLElement, selector: string): T {
  const element = row.querySelector(selector)
  if (!element) throw new Error(`ETA row is missing required child: ${selector}`)
  return element as T
}
