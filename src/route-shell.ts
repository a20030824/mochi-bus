const ROUTE_SCRIPT_SRC = '/assets/route.js'

export function applyRouteShell(response: Response): Response {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!contentType.includes('text/html') || typeof HTMLRewriter === 'undefined') return response

  return new HTMLRewriter()
    .on('body', {
      element(element) {
        element.append(`<script type="module" src="${ROUTE_SCRIPT_SRC}"></script>`, { html: true })
      },
    })
    .transform(response)
}
