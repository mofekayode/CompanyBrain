import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { apiAllowed } from '@companybrain/core/claude'
import { access } from './routes/access'
import { knowledge } from './routes/knowledge'
import { model } from './routes/model'
import { chat } from './routes/chat'
import { config } from './routes/config'
import { evals } from './routes/evals'
import { searchRoutes } from './routes/search'
import { skills } from './routes/skills'
import { app as clientApp } from './routes/app'
import { discovery } from './routes/discovery'
import { files } from './routes/files'
import { pipeline } from './routes/pipeline'
import { tenants } from './routes/tenants'
import { uploads } from './routes/uploads'
import { evalContract } from './routes/eval-contract'
import { type Env, withTenant } from './tenant'

/** Browser origins allowed to call the API (the FDE portal). Comma-separated. */
const WEB_ORIGINS = (process.env.WEB_ORIGINS ?? 'http://127.0.0.1:4317,http://localhost:4317,http://127.0.0.1:4320,http://localhost:4320').split(',').map((o) => o.trim())

export const app = new Hono()

app.use('*', logger())
app.use('/api/*', cors({ origin: WEB_ORIGINS, allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'OPTIONS'], maxAge: 600 }))

app.get('/health', (c) => c.json({ ok: true }))
/** Which paid services the pipeline may call (the portal disables AI actions when off). */
app.get('/api/status', (c) => c.json({ claude_api: apiAllowed() }))

app.route('/api', tenants)
// The external eval runner's contract (docs/eval-contract.md), at the root as the runner expects.
app.route('/', evalContract)

const client = new Hono<Env>()
client.use('*', withTenant)
client.route('/', files)
client.route('/', pipeline)
client.route('/', discovery)
client.route('/', chat)
client.route('/', uploads)
client.route('/', access)
client.route('/', model)
client.route('/', knowledge)
client.route('/', config)
client.route('/', evals)
client.route('/', searchRoutes)
client.route('/', skills)
client.route('/', clientApp)
app.route('/api/t/:slug', client)

app.onError((error, c) => {
  console.error(error)
  return c.json({ error: error.message }, 500)
})
