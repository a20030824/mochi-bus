const ROUTE_SCRIPT_SRC = '/assets/route.js'

export function applyRouteShell(response: Response): Response {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/html') || typeof HTMLRewriter === 'undefined') return response

  return new HTMLRewriter()
    .on('.route-stop.selected .route-eta', {
      element(element) {
        element.setAttribute('aria-live', 'polite')
        element.setAttribute('aria-atomic', 'true')
      },
    })
    .on('body', {
      element(element) {
        element.append(`<script type="module" src="${ROUTE_SCRIPT_SRC}"></script>`, { html: true })
      },
    })
    .transform(response)
}
