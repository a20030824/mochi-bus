import {
  clearHomeBoard,
  migrateBoards,
  readHomeBoard,
  saveHomeBoardToFavorites,
} from '../boards/store'

const boardList = document.querySelector('#board-list') as HTMLDivElement | null
const addBoardButton = document.querySelector('#add-board-button') as HTMLButtonElement | null

function renderHomeBoardCard(): void {
  if (!boardList || boardList.querySelector('[data-home-draft="true"]')) return
  migrateBoards()
  const board = readHomeBoard()
  if (!board) return

  boardList.querySelector(':scope > .empty')?.remove()
  boardList.querySelectorAll(':scope > .board-item').forEach((card) => {
    ;(card as HTMLElement).dataset.active = 'false'
    card.querySelector('.board-status')?.remove()
  })
  boardList.classList.add('has-boards')
  addBoardButton?.classList.remove('empty-state')

  const card = document.createElement('article')
  card.className = 'board-item'
  card.dataset.active = 'true'
  card.dataset.homeDraft = 'true'

  const copy = document.createElement('div')
  copy.className = 'board-copy'
  const titleLine = document.createElement('div')
  titleLine.className = 'board-title-line'
  const title = document.createElement('strong')
  title.className = 'favorite-stop-name'
  title.textContent = board.title
  const status = document.createElement('span')
  status.className = 'board-status'
  status.textContent = '封面'
  titleLine.appendChild(title)
  titleLine.appendChild(status)

  const detail = document.createElement('div')
  detail.className = 'board-route-chips'
  for (const routeName of new Set(board.buses.map((bus) => bus.routeName))) {
    const chip = document.createElement('span')
    chip.className = 'favorite-route-number'
    chip.textContent = routeName
    detail.appendChild(chip)
  }
  if (board.buses.some((bus) => bus.identityStatus === 'legacy-ambiguous')) {
    const note = document.createElement('span')
    note.className = 'route-chip-note'
    note.textContent = '需重新選擇路線'
    detail.appendChild(note)
  }
  copy.appendChild(titleLine)
  copy.appendChild(detail)

  const actions = document.createElement('div')
  actions.className = 'item-actions'
  const save = document.createElement('button')
  save.className = 'board-cover-action'
  save.textContent = '加入常用'
  save.addEventListener('click', () => {
    saveHomeBoardToFavorites()
    location.reload()
  })
  const remove = document.createElement('button')
  remove.className = 'board-delete-action'
  remove.textContent = '刪除'
  remove.addEventListener('click', () => {
    clearHomeBoard()
    location.reload()
  })
  actions.appendChild(save)
  actions.appendChild(remove)
  card.appendChild(copy)
  card.appendChild(actions)
  boardList.insertBefore(card, boardList.firstChild)
}

renderHomeBoardCard()

if (boardList) {
  const observer = new MutationObserver(() => {
    if (readHomeBoard() && !boardList.querySelector('[data-home-draft="true"]')) renderHomeBoardCard()
  })
  observer.observe(boardList, { childList: true })
}
