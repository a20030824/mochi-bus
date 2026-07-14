import { describe, expect, it } from 'vitest'
import app from './index'

const baseUrl = 'https://bus.moc96336.com'

describe('journey ETA request protection', () => {
  it('rejects payloads larger than 16 KiB before parsing JSON', async () => {
    const response = await app.request(`${baseUrl}/api/v1/map/journey-eta`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ city: 'Taipei', legs: [], padding: 'x'.repeat(17_000) }),
    })

    expect(response.status).toBe(413)
    await expect(response.json()).resolves.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' })
  })

  it('distinguishes unsupported media types and malformed JSON', async () => {
    const unsupported = await app.request(`${baseUrl}/api/v1/map/journey-eta`, {
      method: 'POST', body: '{}',
    })
    expect(unsupported.status).toBe(415)
    await expect(unsupported.json()).resolves.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' })

    const malformed = await app.request(`${baseUrl}/api/v1/map/journey-eta`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
    })
    expect(malformed.status).toBe(400)
    await expect(malformed.json()).resolves.toMatchObject({ code: 'INVALID_JSON' })
  })

  it('rejects semantically invalid or duplicate legs without touching bindings', async () => {
    const invalid = await postJourney({
      city: 'Taipei',
      legs: [
        { key: 'valid', patternId: 'TPE123:0:0', sequence: 1 },
        { key: '', patternId: 'TPE123:0:0', sequence: 2 },
      ],
    })
    expect(invalid.status).toBe(422)
    await expect(invalid.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' })

    const duplicate = await postJourney({
      city: 'Taipei',
      legs: [
        { key: 'same', patternId: 'A', sequence: 1 },
        { key: 'same', patternId: 'B', sequence: 2 },
      ],
    })
    expect(duplicate.status).toBe(422)
    await expect(duplicate.json()).resolves.toMatchObject({ error: 'ETA key 不可重複' })
  })
})

describe('GET and credential boundaries', () => {
  it('rejects invalid coordinates and radius values before D1 access', async () => {
    const latitude = await app.request(`${baseUrl}/api/v1/map/nearby?city=Taipei&lat=91&lon=121.5`)
    expect(latitude.status).toBe(400)
    await expect(latitude.json()).resolves.toMatchObject({ code: 'INVALID_QUERY' })

    const radius = await app.request(`${baseUrl}/api/v1/map/nearby?city=Taipei&lat=25&lon=121.5&radius=NaN`)
    expect(radius.status).toBe(400)
    await expect(radius.json()).resolves.toMatchObject({ code: 'INVALID_QUERY' })
  })

  it('rejects invalid optional directions and oversized path identifiers', async () => {
    const direction = await app.request(`${baseUrl}/api/v1/map/vehicles?city=Taipei&route=307&direction=3`)
    expect(direction.status).toBe(400)
    await expect(direction.json()).resolves.toMatchObject({ code: 'INVALID_QUERY' })

    const place = await app.request(`${baseUrl}/api/v1/map/place/${'x'.repeat(101)}?city=Taipei`)
    expect(place.status).toBe(400)
    await expect(place.json()).resolves.toMatchObject({ code: 'INVALID_QUERY' })
  })

  it('rejects partial or oversized BYOK credentials before token exchange', async () => {
    const partial = await app.request(`${baseUrl}/api/v1/eta`, {
      headers: { 'x-tdx-client-id': 'only-an-id' },
    })
    expect(partial.status).toBe(400)
    await expect(partial.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' })

    const oversized = await app.request(`${baseUrl}/api/v1/tdx/verify`, {
      headers: {
        'x-tdx-client-id': 'x'.repeat(121),
        'x-tdx-client-secret': 'secret',
      },
    })
    expect(oversized.status).toBe(400)
    await expect(oversized.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' })
  })
})

async function postJourney(body: unknown): Promise<Response> {
  return await app.request(`${baseUrl}/api/v1/map/journey-eta`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
