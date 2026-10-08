// Company Brain API: one Node.js process serving every backend endpoint.
// The FDE portal (apps/web) calls it over HTTP; slow work goes to apps/worker via the job queue.

import { serve } from '@hono/node-server'
import { app } from './app'

const port = Number(process.env.API_PORT ?? 4318)
const hostname = process.env.API_HOST ?? '127.0.0.1'

const server = serve({ fetch: app.fetch, port, hostname }, (info) => console.log(`api listening on http://${info.address}:${info.port}`))
// Agent turns stream for many minutes: no server-side response timeout.
server.setTimeout(0)

for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => server.close(() => process.exit(0)))
