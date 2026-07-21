import type { Context } from 'hono'
import { supportedCityCodes } from '../config'
import { QueryValidationError } from '../domain/bus-query'
import { getCityNetwork } from '../infrastructure/transit/snapshot-repository'
import { mapJsonError, type MapEnv } from './map-http-context'

// This handler owns only the HTTP contract; the repository decides stream versus inline delivery.
export async function readCityNetwork(c: Context<MapEnv>) {
  try {
    const city = c.req.query('city')?.trim()
    if (!city || !supportedCityCodes.has(city)) throw new QueryValidationError('請選擇縣市')

    const network = await getCityNetwork(c.env, city)
    if (!network) return c.json({ error: '這個縣市尚未建立全路網資料' }, 404)

    // Large R2 bundles must remain byte-for-byte streams. Parsing them in the Worker can exceed
    // the isolate memory limit, and the bundle already contains schemaVersion and city.
    if (network.kind === 'stream') {
      return new Response(network.body, {
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'public, max-age=86400',
          'ETag': network.etag,
        },
      })
    }

    return c.json({ schemaVersion: 1, city, ...network.network }, 200, {
      'Cache-Control': 'public, max-age=86400',
    })
  } catch (error) {
    return mapJsonError(c, error, '全路網讀取失敗')
  }
}
