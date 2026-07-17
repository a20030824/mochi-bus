export function networkStopRadius(zoom: number): number {
  return zoom >= 15 ? 4 : zoom >= 12 ? 2.5 : 1.4
}
