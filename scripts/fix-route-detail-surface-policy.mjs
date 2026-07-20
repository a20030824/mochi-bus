import fs from 'node:fs'

const presentationPath = 'web/map/route-detail-presentation.ts'
let presentation = fs.readFileSync(presentationPath, 'utf8')
const metricsBlock = `export function routeStopMarkerMetrics(zoom: number, prominent = false): { radius: number; weight: number } {
  if (prominent) return { radius: zoom >= 16 ? 11 : 9, weight: 2.4 }
  if (zoom >= 16) return { radius: 8, weight: 1.8 }
  if (zoom >= 13) return { radius: 5, weight: 1.4 }
  return { radius: 2, weight: 1 }
}
`
if (!presentation.includes(metricsBlock)) throw new Error('route stop marker metrics block changed')
presentation = presentation.replace(metricsBlock, `${metricsBlock}
export function initialRouteStopMarkerMetrics(
  zoom: number,
  prominent = false,
): { radius: number; weight: number } {
  const metrics = routeStopMarkerMetrics(zoom, prominent)
  return { radius: metrics.radius, weight: prominent ? metrics.weight : 1.4 }
}
`)
fs.writeFileSync(presentationPath, presentation)

const surfacePath = 'web/map/route-detail-surface.ts'
let surface = fs.readFileSync(surfacePath, 'utf8')
surface = surface.replace("import { bindTextTooltip } from './leaflet-tooltip'\n", '')
surface = surface.replace(
  `import {
  normalizedVehicleAzimuth,
  routeStopMarkerMetrics,
  routeVariantPreviewStyle,
} from './route-detail-presentation'`,
  `import {
  initialRouteStopMarkerMetrics,
  normalizedVehicleAzimuth,
  routeStopMarkerMetrics,
  routeVariantPreviewStyle,
} from './route-detail-presentation'`,
)
surface = surface.replace(
  'const metrics = routeStopMarkerMetrics(options.map.getZoom(), prominent)',
  'const metrics = initialRouteStopMarkerMetrics(options.map.getZoom(), prominent)',
)
fs.writeFileSync(surfacePath, surface)
