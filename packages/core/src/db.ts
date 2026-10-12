import pg from 'pg'
import { readEnv } from './env'

const PROJECT_REF = 'slenbyoxbqostlxwshdp'

/**
 * Server-side Postgres connection as the database owner, so RLS does not apply.
 * Only for trusted workers and scripts, never for code that runs on behalf of a user.
 *
 * Uses SUPABASE_DB_URL when set, otherwise builds the Supavisor session-pooler URL
 * from DATABASE_PASSWORD (+ optional SUPABASE_POOLER_HOST).
 */
export function serviceConnectionString(): string {
  const env = readEnv(['SUPABASE_DB_URL', 'DATABASE_PASSWORD', 'SUPABASE_POOLER_HOST'] as const)
  if (env.SUPABASE_DB_URL) return env.SUPABASE_DB_URL
  if (!env.DATABASE_PASSWORD) throw new Error('Set SUPABASE_DB_URL or DATABASE_PASSWORD in .env')
  const host = env.SUPABASE_POOLER_HOST ?? 'aws-0-us-east-1.pooler.supabase.com'
  return `postgresql://postgres.${PROJECT_REF}:${encodeURIComponent(env.DATABASE_PASSWORD)}@${host}:5432/postgres`
}

export async function connectService(): Promise<pg.Client> {
  const client = new pg.Client({ connectionString: serviceConnectionString(), ssl: { rejectUnauthorized: false } })
  await client.connect()
  return client
}

/** A connection the pooler dropped (reset, closed, timed out): worth one retry on a fresh connection. */
const DROPPED = /ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|Connection terminated|terminating connection|server closed the connection|connection timeout/i

/**
 * Pooled variant for servers, scripts and workers that issue queries concurrently. Built to survive the
 * session pooler dropping connections mid-run (seen after ~130 requests in a row): an error on an idle
 * connection is logged rather than crashing the process, a request never waits forever for a
 * connection or a query, idle connections are kept alive and recycled, and a query whose connection
 * was dropped is retried once on a fresh one.
 */
export function createServicePool(max = 4): pg.Pool {
  const pool = new pg.Pool({
    connectionString: serviceConnectionString(),
    ssl: { rejectUnauthorized: false },
    max,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    idleTimeoutMillis: 60_000,
    query_timeout: 120_000,
    statement_timeout: 120_000,
  })
  pool.on('error', (err) => console.error(`[db] idle connection error: ${err.message}`))
  const query = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>
  ;(pool as unknown as { query: unknown }).query = async (...args: unknown[]) => {
    try {
      return await query(...args)
    } catch (err) {
      if (!DROPPED.test(String((err as Error).message)) || typeof args.at(-1) === 'function') throw err
      console.error(`[db] retrying after dropped connection: ${(err as Error).message}`)
      return query(...args)
    }
  }
  return pool
}
