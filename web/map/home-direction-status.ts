import {
  HOME_DIRECTION_CHANGED_EVENT,
  type HomeDirectionChangedDetail,
} from '../boards/store'

let previousPressed: boolean | undefined

document.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const control = target.closest('.favorite-direction-button')
  if (!(control instanceof HTMLButtonElement)) return
  previousPressed = control.getAttribute('aria-pressed') === 'true'
}, true)

window.addEventListener(HOME_DIRECTION_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent<HomeDirectionChangedDetail>).detail
  const status = document.getElementById('map-status')
  if (!status || !detail) return
  const guardedLastDirection = previousPressed === true && detail.selected
  previousPressed = undefined
  status.textContent = guardedLastDirection
    ? '首頁至少保留一個方向；可先選另一站牌，或從常用切換封面'
    : detail.selected
      ? `已將「${detail.placeName}」的這個方向加入首頁`
      : detail.homeTitle
        ? `已從首頁移除這個方向，封面回到「${detail.homeTitle}」`
        : '已從首頁移除這個方向'
  status.classList.remove('dismissed', 'error')
  status.removeAttribute('aria-hidden')
})
