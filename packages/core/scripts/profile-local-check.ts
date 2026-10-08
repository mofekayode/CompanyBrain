// Read-only dry run of the profiler over local folders, before (or without) landing.
// Usage: npx tsx scripts/profile-local-check.ts <dir> [<dir> ...] [--odd]
// Prints aggregate formats/categories/issues; --odd lists files whose content contradicts their extension.
import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { profileObject } from '../src/profiling/profile'

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)])))).flat()
}
const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'))
if (dirs.length === 0) throw new Error('usage: profile-local-check.ts <dir> [<dir> ...] [--odd]')
const files = (await Promise.all(dirs.map(walk))).flat()
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1)
const formats = new Map<string, number>(), categories = new Map<string, number>(), issues = new Map<string, number>()
let crashed = 0
for (const f of files) {
  try {
    const p = await profileObject(await readFile(f), basename(f))
    tally(formats, p.format); tally(categories, `${p.category}/${p.structure}`)
    if (process.argv.includes('--odd') && (!p.extension_matches || p.format === 'unknown' || !p.integrity.ok)) console.log('ODD', p.format, p.integrity.issues.join('; '), f)
    for (const i of p.integrity.issues) tally(issues, i.replace(/\d+/g, 'N').slice(0, 70))
  } catch (e) { crashed++; console.log('CRASH', f, (e as Error).message) }
}
const show = (t: string, m: Map<string, number>) => console.log(t, [...m].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join('  '))
console.log(`files ${files.length}, crashed ${crashed}`)
show('formats   ', formats); show('categories', categories); show('issues    ', issues)
