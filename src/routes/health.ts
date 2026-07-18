import { Hono } from 'hono'
import { releaseIdentityDocument } from '../observability/release-identity'

type ReleaseBindings = Pick<CloudflareBindings, 'CF_VERSION_METADATA'>
type Env = { Bindings: ReleaseBindings }

const health = new Hono<Env>()

health.get('/api/v1/health/release', (c) => c.json(
  releaseIdentityDocument(c.env?.CF_VERSION_METADATA),
  200,
  { 'Cache-Control': 'no-store' },
))

export default health
