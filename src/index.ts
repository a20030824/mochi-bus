import { Hono } from 'hono'
import bus from './routes/bus'
import map from './routes/map'

const app = new Hono()
app.route('/', map)
app.route('/', bus)

export default app
