'use client'

// Everything the signed-in person can look up by name, loaded once in the background so typing
// a customer, person, site or asset matches instantly in the browser (no network per keystroke).

import { useEffect, useState } from 'react'
import { tenantApi } from '@/lib/api'
import type { Suggestions } from './use-suggest'

export interface Entry {
  id: string
  name: string
  type: string
  detail: string | null
  aliases: { alias: string; kind: string }[]
  weight: number
}

const cache = new Map<string, Promise<Entry[]>>()
export function loadDirectory(slug: string, as: string | undefined) {
  const key = `${slug}:${as ?? ''}`
  if (!cache.has(key)) cache.set(key, fetch(`${tenantApi(slug)}/app/directory?as=${as ?? ''}`).then((r) => (r.ok ? r.json() : [])).catch(() => []))
  return cache.get(key)!
}

export function useDirectory(slug: string, as: string | undefined) {
  const [entries, setEntries] = useState<Entry[] | null>(null)
  useEffect(() => {
    let alive = true
    loadDirectory(slug, as).then((e) => alive && setEntries(e))
    return () => {
      alive = false
    }
  }, [slug, as])
  return entries
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Exact > starts with > a word starts with > contains, then how much the record knows about it. */
export function matchDirectory(entries: Entry[], raw: string, n = 10): Suggestions['entities'] {
  const q = raw.trim().toLowerCase()
  if (q.length < 2) return []
  const word = new RegExp(`\\b${esc(q)}`)
  const score = (t: string) => {
    const x = t.toLowerCase()
    return x === q ? 4 : x.startsWith(q) ? 3 : word.test(x) ? 2 : x.includes(q) ? 1 : 0
  }
  const out: { e: Entry; s: number; matched: string | null; kind: string | null }[] = []
  for (const e of entries) {
    let best = score(e.name) * 10
    let matched: string | null = null
    let kind: string | null = null
    for (const a of e.aliases) {
      const s = score(a.alias) * 10 - 0.5
      if (s > best) {
        best = s
        matched = a.alias
        kind = a.kind
      }
    }
    if (best > 0) out.push({ e, s: best + Math.log1p(e.weight), matched, kind })
  }
  return out
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ e, matched, kind }) => ({ id: e.id, name: e.name, type: e.type, matched, detail: e.detail ?? (matched ? (kind === 'former_name' ? `formerly ${matched}` : `“${matched}”`) : null) }))
}
