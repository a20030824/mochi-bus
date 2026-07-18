export const RELEASE_IDENTITY_SCHEMA_VERSION = 1 as const

type VersionMetadata = CloudflareBindings['CF_VERSION_METADATA']

export type ReleaseIdentity = Readonly<{
  releaseSha: string | null
  workerVersionId: string | null
  workerCreatedAt: string | null
  deploymentId: null
}>

export type ReleaseIdentityDocument = Readonly<{
  schemaVersion: typeof RELEASE_IDENTITY_SCHEMA_VERSION
  releaseSha: string | null
  workerVersionId: string | null
  workerCreatedAt: string | null
}>

const unknownReleaseIdentity: ReleaseIdentity = Object.freeze({
  releaseSha: null,
  workerVersionId: null,
  workerCreatedAt: null,
  deploymentId: null,
})

const fullGitSha = /^[0-9a-f]{40}$/
const safeWorkerVersionId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const isoTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/

export function releaseIdentity(metadata: VersionMetadata | null | undefined): ReleaseIdentity {
  try {
    if (!metadata) return unknownReleaseIdentity
    return Object.freeze({
      releaseSha: fullGitSha.test(metadata.tag) ? metadata.tag : null,
      workerVersionId: safeWorkerVersionId.test(metadata.id) ? metadata.id : null,
      workerCreatedAt: normalizedTimestamp(metadata.timestamp),
      deploymentId: null,
    })
  } catch {
    return unknownReleaseIdentity
  }
}

export function releaseIdentityDocument(metadata: VersionMetadata | null | undefined): ReleaseIdentityDocument {
  const identity = releaseIdentity(metadata)
  return Object.freeze({
    schemaVersion: RELEASE_IDENTITY_SCHEMA_VERSION,
    releaseSha: identity.releaseSha,
    workerVersionId: identity.workerVersionId,
    workerCreatedAt: identity.workerCreatedAt,
  })
}

function normalizedTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !isoTimestamp.test(value)) return null
  const milliseconds = Date.parse(value)
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null
}
