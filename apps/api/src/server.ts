// Company Brain API: one Node.js process serving every backend endpoint.
// The FDE portal (apps/web) calls it over HTTP; slow work goes to apps/worker via the job queue.

import { serve } from '@hono/node-server'
import { app } from './app'
import { warmEval } from './routes/eval-contract'

const port = Number(process.env.API_PORT ?? 4318)
const hostname = process.env.API_HOST ?? '127.0.0.1'

const server = serve({ fetch: app.fetch, port, hostname }, (info) => console.log(`api listening on http://${info.address}:${info.port}`))
// The eval runner's first question shouldn't pay for building the Day 10 knowledge view.
if (process.env.COMPANY_BRAIN_EVAL_WARM !== '0') warmEval().catch((e) => console.error('eval warm-up failed', e))
// Agent turns stream for many minutes: no server-side response timeout.
server.setTimeout(0)

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
