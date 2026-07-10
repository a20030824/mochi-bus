import { Hono } from 'hono'
import bus from './routes/bus'
import map from './routes/map'
import { httpsRedirectTarget, securityHeaders } from './security'

const app = new Hono()

app.use('*', async (c, next) => {
  const requestUrl = new URL(c.req.url)
  const redirectTarget = httpsRedirectTarget(requestUrl.toString())
  const headers = securityHeaders(requestUrl.protocol === 'https:')

  for (const [name, value] of Object.entries(headers)) c.header(name, value)
  if (redirectTarget) return c.redirect(redirectTarget, 308)

  await next()

  // Keep route-specific policies when they are stricter than the global defaults.
  for (const [name, value] of Object.entries(headers)) {
    if (!c.res.headers.has(name)) c.header(name, value)
  }
})

app.route('/', map)
app.route('/', bus)

export default app
