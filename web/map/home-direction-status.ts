import {
  HOME_DIRECTION_CHANGED_EVENT,
  type HomeDirectionChangedDetail,
} from '../boards/store'

window.addEventListener(HOME_DIRECTION_CHANGED_EVENT, (event) => {
  const detail = (event as CustomEvent<HomeDirectionChangedDetail>).detail
  const status = document.getElementById('map-status')
  if (!status || !detail) return
  status.textContent = detail.selected
    ? `已將「${detail.placeName}」的這個方向加入首頁`
    : detail.homeTitle
      ? `已從首頁移除這個方向，封面回到「${detail.homeTitle}」`
      : '已從首頁移除這個方向'
  status.classList.remove('dismissed', 'error')
  status.removeAttribute('aria-hidden')
})
