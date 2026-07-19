import { pathToFileURL } from 'node:url'
import { scheduledCitiesForTaipeiDate, taipeiDate } from './snapshot-schedule.mjs'

export function scheduledCitiesAt(now = new Date()) {
  return scheduledCitiesForTaipeiDate(taipeiDate(now))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(scheduledCitiesAt().join(' '))
}
