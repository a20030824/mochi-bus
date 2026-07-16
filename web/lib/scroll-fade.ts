// 捲動漸層只在「下面真的還有內容」時出現:內容剛好放得下、或已捲到底時,
// 常駐的漸層只會把最後一個元件洗白,看起來像破版。純 CSS 的 scroll-driven
// animation 尚未全瀏覽器可用,用最小的觀察器組合開關 class。
export function hasScrollableContentBelow(
  scrollHeight: number,
  scrollTop: number,
  clientHeight: number,
): boolean {
  return scrollHeight - scrollTop - clientHeight > 4
}

export function attachScrollFade(element: HTMLElement, className = 'scrollable-below'): () => void {
  let attached = true
  const update = () => {
    if (!attached) return
    element.classList.toggle(
      className,
      hasScrollableContentBelow(element.scrollHeight, element.scrollTop, element.clientHeight),
    )
  }
  element.addEventListener('scroll', update, { passive: true })
  const resizeObserver = new ResizeObserver(update)
  const mutationObserver = new MutationObserver(update)
  resizeObserver.observe(element)
  mutationObserver.observe(element, { childList: true, subtree: true })
  update()

  return () => {
    if (!attached) return
    attached = false
    element.removeEventListener('scroll', update)
    resizeObserver.disconnect()
    mutationObserver.disconnect()
    element.classList.remove(className)
  }
}
