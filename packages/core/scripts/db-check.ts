// Checks the service connection to Supabase. Usage: npx tsx scripts/db-check.ts
import pg from 'pg'
import { serviceConnectionString } from '../src/db'

const hosts = process.env.SUPABASE_POOLER_HOST
  ? [process.env.SUPABASE_POOLER_HOST]
  : ['aws-0-us-east-1.pooler.supabase.com', 'aws-1-us-east-1.pooler.supabase.com']

for (const host of hosts) {
  process.env.SUPABASE_POOLER_HOST = host
  const client = new pg.Client({ connectionString: serviceConnectionString(), ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 8000 })
  try {
    await client.connect()
    const { rows } = await client.query(`select current_user, (select count(*) from public.tenants) as tenants`)
    console.log(`${host}: OK`, rows[0])
    await client.end()
    process.exit(0)
  } catch (error) {
    console.log(`${host}: FAIL ${(error as Error).message.slice(0, 120)}`)
  }
}
process.exit(1)
