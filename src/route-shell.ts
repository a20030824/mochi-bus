const ROUTE_SCRIPT_SRC = '/assets/route.js'
const ROUTE_STYLE_OVERRIDES = '.route-stop>div{align-items:baseline}.route-stop.selected em{transform:translateY(1px)}'

export function applyRouteShell(response: Response): Response {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/html') || typeof HTMLRewriter === 'undefined') return response

  return new HTMLRewriter()
    .on('head', {
      element(element) {
        element.append(`<style>${ROUTE_STYLE_OVERRIDES}</style>`, { html: true })
      },
    })
    .on('body', {
      element(element) {
        element.append(`<script type="module" src="${ROUTE_SCRIPT_SRC}"></script>`, { html: true })
      },
    })
    .transform(response)
}
