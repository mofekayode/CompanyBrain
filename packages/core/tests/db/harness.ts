import { PGlite, type Transaction } from '@electric-sql/pglite'
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const MIGRATIONS_DIR = join(import.meta.dirname, '../../../../supabase/migrations')

// The minimum of Supabase the migrations depend on: its roles, auth.users and auth.uid().
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;

  create schema auth;
  grant usage on schema auth to anon, authenticated, service_role;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
`

export async function createDb(): Promise<PGlite> {
  const db = new PGlite({ extensions: { pg_trgm } })
  await db.exec(SUPABASE_STUB)
  for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf8'))
  }
  return db
}

type Tx = Transaction

async function withRole<T>(db: PGlite, role: string, userId: string | null, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [userId ?? ''])
    await tx.exec(`set local role ${role}`)
    return fn(tx)
  })
}

/** Run as a signed-in Supabase user (RLS applies). */
export const asUser = <T>(db: PGlite, userId: string, fn: (tx: Tx) => Promise<T>) =>
  withRole(db, 'authenticated', userId, fn)

/** Run as an unauthenticated client (RLS applies). */
export const asAnon = <T>(db: PGlite, fn: (tx: Tx) => Promise<T>) => withRole(db, 'anon', null, fn)

/** Run as the service role used by ingestion workers (bypasses RLS). */
export const asService = <T>(db: PGlite, fn: (tx: Tx) => Promise<T>) => withRole(db, 'service_role', null, fn)

export async function createUser(db: PGlite, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into auth.users (id, email) values (gen_random_uuid(), $1) returning id`,
    [email],
  )
  return rows[0].id
}

export async function one<T>(tx: Tx | PGlite, sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await tx.query<T>(sql, params)
  if (rows.length !== 1) throw new Error(`expected 1 row, got ${rows.length}: ${sql}`)
  return rows[0]
}
