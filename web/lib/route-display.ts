export type RouteDisplayName = {
  name: string
  note?: string
}

export function splitRouteDisplayName(routeName: string): RouteDisplayName {
  const match = routeName.match(/^(.*?)([(（][^()（）]+[)）])$/)
  if (!match || !match[1].trim()) return { name: routeName }
  return { name: match[1].trim(), note: match[2] }
}
