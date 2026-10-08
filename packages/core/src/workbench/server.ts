import type pg from 'pg'
import { companyBrainStore } from '../aws'
import { createServicePool } from '../db'
import type { S3ObjectStore } from '../storage/object-store'

// One pool and one S3 store per server process (survives dev hot reloads).
const g = globalThis as unknown as { __cbPool?: pg.Pool; __cbStore?: Promise<S3ObjectStore> }

export function pool(): pg.Pool {
  g.__cbPool ??= createServicePool(6)
  return g.__cbPool
}

export function store(): Promise<S3ObjectStore> {
  g.__cbStore ??= companyBrainStore()
  return g.__cbStore
}

export async function tenantBySlug(slug: string): Promise<{ id: string; slug: string; name: string } | null> {
  const { rows } = await pool().query<{ id: string; slug: string; name: string }>(`select id, slug, name from public.tenants where slug = $1`, [slug])
  return rows[0] ?? null
}
