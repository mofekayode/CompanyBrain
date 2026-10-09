// Dev tool: compares embedding models for the meaning leg of search, offline (the live index is
// untouched). Embeds every search document with the model (title + content, as indexing does),
// caches the vectors, then for each robustness phrasing ranks all documents by cosine similarity
// and reports where the first gold file lands (top 10 / 30 / 100), per phrasing style.
//
// Usage: npx tsx scripts/embed-bench.ts <slug> <model> [--query-prefix "..."] [--doc-prefix "..."]
//   e.g. Xenova/bge-small-en-v1.5 --query-prefix "Represent this sentence for searching relevant passages: "

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from '@huggingface/transformers'
import { pool } from '../src/workbench/server'

const args = process.argv.slice(2)
const [slug, model] = args
if (!slug || !model) throw new Error('usage: embed-bench.ts <slug> <model> [--query-prefix ...] [--doc-prefix ...]')
const opt = (k: string) => (args.includes(k) ? args[args.indexOf(k) + 1] : '')
const qPrefix = opt('--query-prefix')
const dPrefix = opt('--doc-prefix')
const set = JSON.parse(readFileSync(`../../evals/${slug}/robustness-dev-v1.json`, 'utf8')) as { targets: { gold: string[]; fact: string; q: Record<string, string> }[] }

const db = pool()
const t = (await db.query<{ id: string }>(`select id from public.tenants where slug = $1`, [slug])).rows[0].id
const docs = (
  await db.query<{ id: string; text: string; files: string[] }>(
    `select d.id, d.title || E'\\n' || d.content text,
            coalesce(case when d.source_object_id is not null then array[so.original_path] end,
                     (select array_agg(distinct s2.original_path) from public.evidence e join public.document_versions dv on dv.id = e.document_version_id
                        join public.source_objects s2 on s2.id = dv.source_object_id where e.id = any(d.evidence_ids)), '{}') files
     from public.search_documents d left join public.source_objects so on so.id = d.source_object_id
     where d.tenant_id = $1 order by d.id`,
    [t],
  )
).rows
console.log(`${docs.length} documents`)

const extractor = await pipeline('feature-extraction', model, { dtype: 'q8' })
const embed = async (texts: string[]) => {
  const out = await extractor(texts, { pooling: /bge|arctic|mxbai/i.test(model) ? 'cls' : 'mean', normalize: true })
  return out.tolist() as number[][]
}

// Cache document vectors per model (resume-safe): one Float32 file.
const dir = join(import.meta.dirname, '../../../.cache/embed-bench')
mkdirSync(dir, { recursive: true })
const cache = join(dir, `${slug}-${model.replace(/[^a-z0-9]+/gi, '_')}.f32`)
let dim = 0
let matrix: Float32Array
if (existsSync(cache)) {
  const buf = readFileSync(cache)
  matrix = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  dim = matrix.length / docs.length
  console.log(`cached vectors: ${dim} dims`)
} else {
  const t0 = performance.now()
  const vecs: number[][] = []
  for (let i = 0; i < docs.length; i += 32) {
    vecs.push(...(await embed(docs.slice(i, i + 32).map((d) => dPrefix + d.text.slice(0, 2000)))))
    if (i % 3200 === 0) console.log(`  embedded ${i}/${docs.length} (${Math.round((performance.now() - t0) / 1000)} s)`)
  }
  dim = vecs[0].length
  matrix = new Float32Array(vecs.flat())
  writeFileSync(cache, Buffer.from(matrix.buffer))
  console.log(`embedded ${docs.length} in ${Math.round((performance.now() - t0) / 1000)} s (${dim} dims)`)
}

const tally = new Map<string, number[]>() // style → [top10, top30, top100, total]
let qms = 0
let nq = 0
for (const target of set.targets)
  for (const [style, q] of Object.entries(target.q)) {
    const q0 = performance.now()
    const [v] = await embed([qPrefix + q])
    qms += performance.now() - q0
    nq++
    const scores = new Float32Array(docs.length)
    for (let i = 0; i < docs.length; i++) {
      let s = 0
      for (let k = 0; k < dim; k++) s += matrix[i * dim + k] * v[k]
      scores[i] = s
    }
    const order = [...scores.keys()].sort((a, b) => scores[b] - scores[a]).slice(0, 100)
    const rank = order.findIndex((i) => docs[i].files.some((f) => target.gold.some((g) => f.includes(g)))) + 1
    const row = tally.get(style) ?? [0, 0, 0, 0]
    if (rank && rank <= 10) row[0]++
    if (rank && rank <= 30) row[1]++
    if (rank && rank <= 100) row[2]++
    row[3]++
    tally.set(style, row)
  }
console.log(`=== ${model}: meaning leg alone · ${Math.round(qms / nq)} ms per query embedding`)
console.log(`style        top10  top30  top100`)
const all = [0, 0, 0, 0]
for (const [style, r] of tally) {
  console.log(`${style.padEnd(11)} ${`${r[0]}/${r[3]}`.padStart(6)} ${`${r[1]}/${r[3]}`.padStart(6)} ${`${r[2]}/${r[3]}`.padStart(7)}`)
  r.forEach((x, i) => (all[i] += x))
}
console.log(`${'all'.padEnd(11)} ${`${all[0]}/${all[3]}`.padStart(6)} ${`${all[1]}/${all[3]}`.padStart(6)} ${`${all[2]}/${all[3]}`.padStart(7)}`)
await db.end()
