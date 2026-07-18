import { describe, expect, it } from 'vitest'
import health from '../routes/health'
import {
  RELEASE_IDENTITY_SCHEMA_VERSION,
  releaseIdentity,
  releaseIdentityDocument,
} from './release-identity'
import {
  createTelemetryEnvelope,
  TELEMETRY_EVENT_SCHEMA,
  type TelemetryEnvelopeFields,
} from './telemetry'

const releaseSha = '0123456789abcdef0123456789abcdef01234567'
const metadata = {
  id: '8d3e7c40-5e9e-4f86-bd85-51b0cf9e6b32',
  tag: releaseSha,
  timestamp: '2026-07-19T02:15:30.123Z',
} satisfies CloudflareBindings['CF_VERSION_METADATA']

const unknownIdentity = {
  releaseSha: null,
  workerVersionId: null,
  workerCreatedAt: null,
  deploymentId: null,
}

describe('release identity', () => {
  it('maps Version Metadata to a release identity without inventing a deployment ID', () => {
    expect(releaseIdentity(metadata)).toEqual({
      releaseSha,
      workerVersionId: metadata.id,
      workerCreatedAt: metadata.timestamp,
      deploymentId: null,
    })
  })

  it.each(['', '0123456', 'release-main', `${releaseSha}0`, releaseSha.toUpperCase()])(
    'does not treat malformed version tag %j as a Git SHA',
    (tag) => {
      expect(releaseIdentity({ ...metadata, tag })).toMatchObject({
        releaseSha: null,
        workerVersionId: metadata.id,
      })
    },
  )

  it('returns explicit nulls when the local binding is missing', () => {
    expect(releaseIdentity(undefined)).toEqual(unknownIdentity)
    expect(releaseIdentity(null)).toEqual(unknownIdentity)
  })

  it('normalizes a valid offset timestamp and rejects malformed metadata fields', () => {
    expect(releaseIdentity({
      ...metadata,
      timestamp: '2026-07-19T10:15:30+08:00',
    }).workerCreatedAt).toBe('2026-07-19T02:15:30.000Z')

    expect(releaseIdentity({
      id: 'invalid version id with spaces',
      tag: releaseSha,
      timestamp: 'yesterday',
    })).toEqual({
      releaseSha,
      workerVersionId: null,
      workerCreatedAt: null,
      deploymentId: null,
    })
  })

  it('fails open if a malformed binding throws while being read', () => {
    const broken = new Proxy(metadata, {
      get: () => { throw new Error('binding unavailable') },
    })

    expect(() => releaseIdentity(broken)).not.toThrow()
    expect(releaseIdentity(broken)).toEqual(unknownIdentity)
  })

  it('builds the telemetry envelope from the same sanitized identity', () => {
    const identity = releaseIdentity(metadata)
    const fields: TelemetryEnvelopeFields = {
      eventSchema: TELEMETRY_EVENT_SCHEMA,
      event: 'release_smoke_completed',
      city: null,
      operation: 'release_smoke',
      result: 'success',
      source: 'worker',
      snapshotVersion: null,
      httpStatusClass: '2xx',
      latencyBucket: '50_199ms',
      cacheResult: 'not_applicable',
      trafficClass: 'synthetic',
      sampleProbability: 1,
      failureClass: 'none',
      emptyReason: 'not_applicable',
      qualityBucket: 'not_applicable',
    }

    expect(createTelemetryEnvelope(identity, fields)).toMatchObject(identity)
    const brokenFields = new Proxy(fields, {
      ownKeys: () => { throw new Error('telemetry fields unavailable') },
    })
    expect(() => createTelemetryEnvelope(identity, brokenFields)).not.toThrow()
    expect(createTelemetryEnvelope(identity, brokenFields)).toBeUndefined()
  })
})

describe('release identity endpoint', () => {
  it('returns only the fixed release document and is never cached', async () => {
    const metadataWithExtraFields = {
      ...metadata,
      message: 'must not be exposed',
      environment: { secret: 'must not be exposed' },
    }
    const response = await health.request(
      'https://bus.example/api/v1/health/release',
      {},
      { CF_VERSION_METADATA: metadataWithExtraFields },
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({
      schemaVersion: RELEASE_IDENTITY_SCHEMA_VERSION,
      releaseSha,
      workerVersionId: metadata.id,
      workerCreatedAt: metadata.timestamp,
    })
  })

  it('keeps serving a bounded unknown document when the binding is absent or throws', async () => {
    const absent = await health.request('https://bus.example/api/v1/health/release')
    const broken = new Proxy(metadata, {
      get: () => { throw new Error('binding unavailable') },
    })
    const failed = await health.request(
      'https://bus.example/api/v1/health/release',
      {},
      { CF_VERSION_METADATA: broken },
    )

    expect(await absent.json()).toEqual(releaseIdentityDocument(undefined))
    expect(failed.status).toBe(200)
    expect(await failed.json()).toEqual(releaseIdentityDocument(undefined))
  })
})
