import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The nearest .env at or above the working directory (each app runs from its own folder). */
function findEnvFile(): string {
  for (let dir = process.cwd(); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.env'))) return join(dir, '.env')
    if (dirname(dir) === dir) return join(process.cwd(), '.env')
  }
}

/**
 * Reads only the named keys from the project's .env (process.env wins).
 * Deliberately never loads the whole file: it also holds secrets that no
 * pipeline process should see.
 */
export function readEnv<K extends string>(keys: readonly K[], envFile = findEnvFile()): Partial<Record<K, string>> {
  const wanted = new Set<string>(keys)
  const fromFile: Record<string, string> = {}
  let text = ''
  try {
    text = readFileSync(envFile, 'utf8')
  } catch {
    // no .env: rely on process.env
  }
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/)
    if (!m || !wanted.has(m[1])) continue
    fromFile[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2')
  }
  const out: Partial<Record<K, string>> = {}
  for (const k of keys) {
    const v = process.env[k] ?? fromFile[k]
    if (v) out[k] = v
  }
  return out
}
