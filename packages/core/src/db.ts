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

/** Pooled variant for scripts and workers that issue queries concurrently. */
export function createServicePool(max = 4): pg.Pool {
  return new pg.Pool({ connectionString: serviceConnectionString(), ssl: { rejectUnauthorized: false }, max })
}
