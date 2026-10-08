'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { matchDirectory, useDirectory } from './directory'
import { useSession } from '@/components/shell/session'
import { tenantApi } from '@/lib/api'

export interface Suggestions {
  query: string
  entities: { id: string; name: string; type: string; detail: string | null; matched: string | null }[]
  files: { id: string; name: string; path: string; kind: string }[]
  emails: { id: string; subject: string; file_id: string | null; date: string | null }[]
}

/**
 * Typeahead as you type: records match instantly from the in-browser directory; files and email
 * come from the server a moment later (debounced, stale responses ignored).
 */
export function useSuggest(q: string) {
  const { slug, me } = useSession()
  const entries = useDirectory(slug, me?.id)
  const [remote, setRemote] = useState<Pick<Suggestions, 'files' | 'emails'> & { query: string } | null>(null)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  useEffect(() => {
    const query = q.trim()
    if (query.length < 2) {
      setRemote(null)
      setLoading(false)
      return
    }
    const n = ++seq.current
    setLoading(true)
    const t = setTimeout(() => {
      fetch(`${tenantApi(slug)}/app/suggest?q=${encodeURIComponent(query)}&as=${me?.id ?? ''}&only=files`)
        .then((r) => r.json())
        .then((d: Suggestions) => n === seq.current && setRemote({ query, files: d.files, emails: d.emails }))
        .catch(() => {})
        .finally(() => n === seq.current && setLoading(false))
    }, 150)
    return () => clearTimeout(t)
  }, [q, slug, me?.id])
  const data = useMemo<Suggestions | null>(() => {
    const query = q.trim()
    if (query.length < 2) return null
    const local = entries ? matchDirectory(entries, query) : []
    const fresh = remote && remote.query === query
    return { query, entities: local, files: fresh ? remote.files : [], emails: fresh ? remote.emails : [] }
  }, [q, entries, remote])
  return { data, loading: loading || !entries }
}

/** Does this read like a question (→ Ask) rather than a lookup (→ Search)? */
export const looksLikeQuestion = (q: string) => /\?\s*$/.test(q) || /^(who|what|when|where|why|how|which|is|are|do|does|did|can|should|has|have|was|were|prepare|tell|show|list|explain|compare)\b/i.test(q.trim())
