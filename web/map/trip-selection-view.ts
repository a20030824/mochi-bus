import type { TripSelectionKind } from '../../src/domain/map/trip-selection'
import type { NearbyPlace, SearchPlace } from './map-api-client'

const FAR_DISTANCE_METERS = 250

export type PlaceSearchBox = {
  element: HTMLElement
  dispose: () => void
}

export function createPlaceSearchResultButton(
  place: SearchPlace,
  onPick: (place: SearchPlace) => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.className = 'nearby-place-button'
  const name = document.createElement('strong')
  name.textContent = place.name
  const kind = document.createElement('span')
  kind.textContent = '站牌'
  button.appendChild(name)
  button.appendChild(kind)
  button.addEventListener('click', () => onPick(place))
  return button
}

export function createPlaceSearchBox(options: {
  placeholder: string
  search: (query: string, signal: AbortSignal) => Promise<SearchPlace[]>
  onPick: (place: SearchPlace) => void
}): PlaceSearchBox {
  const wrap = document.createElement('div')
  wrap.className = 'place-search'
  const input = document.createElement('input')
  input.className = 'map-search'
  input.placeholder = options.placeholder
  input.setAttribute('aria-label', options.placeholder)
  const results = document.createElement('div')
  results.className = 'place-search-results'
  let timer: number | undefined
  let searchController: AbortController | undefined

  input.addEventListener('input', () => {
    window.clearTimeout(timer)
    searchController?.abort()
    const query = input.value.trim()
    if (query.length < 2) {
      results.replaceChildren()
      return
    }
    timer = window.setTimeout(() => {
      const controller = new AbortController()
      searchController = controller
      void (async () => {
        const places = await options.search(query, controller.signal)
        if (controller.signal.aborted || input.value.trim() !== query) return
        if (!places.length) {
          const empty = document.createElement('p')
          empty.textContent = '找不到這個站牌，換個關鍵字試試。'
          results.replaceChildren(empty)
          return
        }
        results.replaceChildren(
          ...places.slice(0, 6).map((place) => createPlaceSearchResultButton(place, options.onPick)),
        )
      })()
    }, 300)
  })

  wrap.appendChild(input)
  wrap.appendChild(results)
  return {
    element: wrap,
    dispose: () => {
      window.clearTimeout(timer)
      searchController?.abort()
    },
  }
}

export function createTripEndpointSummary(options: {
  kind: TripSelectionKind
  selected: NearbyPlace
  matchedDistanceMeters?: number
  onActivate: () => void
}): HTMLButtonElement {
  const label = options.kind === 'from' ? '出發' : '目的地'
  const summary = document.createElement('button')
  summary.type = 'button'
  summary.className = `trip-matched-summary trip-endpoint-${options.kind}`
  summary.dataset.kind = options.kind
  summary.setAttribute('aria-label', `更換${label}站牌：${options.selected.name}`)

  const labelNode = document.createElement('span')
  labelNode.className = 'trip-endpoint-label'
  labelNode.textContent = label
  const action = document.createElement('span')
  action.className = 'trip-endpoint-action'
  action.textContent = '›'
  action.setAttribute('aria-hidden', 'true')
  const name = document.createElement('strong')
  name.className = 'trip-endpoint-name'
  name.textContent = options.selected.name
  summary.appendChild(labelNode)
  summary.appendChild(action)
  summary.appendChild(name)

  if (options.matchedDistanceMeters !== undefined) {
    const distance = document.createElement('span')
    distance.className = 'trip-endpoint-distance'
    distance.textContent = formatDistance(options.matchedDistanceMeters)
    if (isFarDistance(options.matchedDistanceMeters)) {
      distance.classList.add('far')
      distance.title = '距離較遠'
    }
    summary.appendChild(distance)
  }
  summary.addEventListener('click', options.onActivate)
  return summary
}

export function createTripCandidateList(options: {
  candidates: NearbyPlace[]
  selectedPlaceId: string
  onSelect: (candidate: NearbyPlace) => void
}): HTMLDivElement {
  const list = document.createElement('div')
  list.className = 'trip-nearby-candidate-list'
  options.candidates.forEach((candidate) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'trip-nearby-candidate'
    const selected = candidate.placeId === options.selectedPlaceId
    button.classList.toggle('selected', selected)
    button.setAttribute('aria-pressed', String(selected))
    const name = document.createElement('strong')
    name.textContent = candidate.name
    const distance = document.createElement('span')
    distance.textContent = formatDistance(candidate.distanceMeters)
    button.appendChild(name)
    button.appendChild(distance)
    if (isFarDistance(candidate.distanceMeters)) {
      const warning = document.createElement('span')
      warning.className = 'trip-distance-warning'
      warning.textContent = '距離較遠'
      button.appendChild(warning)
    }
    button.addEventListener('click', () => options.onSelect(candidate))
    list.appendChild(button)
  })
  return list
}

export function createReselectTripEndpointButton(
  kind: TripSelectionKind,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'quiet-button trip-endpoint-reselect'
  button.textContent = kind === 'from' ? '重新選出發位置' : '重新選目的地位置'
  button.addEventListener('click', onClick)
  return button
}

function formatDistance(distanceMeters: number): string {
  return `${Math.round(distanceMeters)} m`
}

function isFarDistance(distanceMeters: number): boolean {
  return distanceMeters > FAR_DISTANCE_METERS
}
