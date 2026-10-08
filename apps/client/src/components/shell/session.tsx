'use client'

// Who is signed in. Until Clerk, the person is picked from the company map and remembered
// in this browser; every API call carries their principal, so answers, search, files and
// briefs only ever show what they can open.

import { createContext, useContext, useEffect, useState } from 'react'
import { getJSON, tenantApi } from '@/lib/api'
import type { Person } from '@/lib/types'

interface Session {
  slug: string
  company: string
  me: Person | null
  people: Person[]
  signInAs: (id: string) => void
}
const Ctx = createContext<Session | null>(null)

export function useSession() {
  const s = useContext(Ctx)
  if (!s) throw new Error('useSession outside SessionProvider')
  return s
}

const key = (slug: string) => `cb.client.as.${slug}`

export function SessionProvider({ slug, children }: { slug: string; children: React.ReactNode }) {
  const [people, setPeople] = useState<Person[]>([])
  const [me, setMe] = useState<Person | null>(null)
  const [company, setCompany] = useState(slug)

  useEffect(() => {
    getJSON<{ name: string }>(`${tenantApi(slug).replace(`/t/${slug}`, `/tenants/${slug}`)}`)
      .then((t) => t?.name && setCompany(t.name))
      .catch(() => {})
    getJSON<Person[]>(`${tenantApi(slug)}/app/people`).then((ps) => {
      setPeople(ps)
      let saved: string | null = null
      try {
        saved = localStorage.getItem(key(slug))
      } catch {}
      // Demo links: ?as=<person name or id> signs in as that person (until real sign-in).
      const asked = new URLSearchParams(window.location.search).get('as')?.toLowerCase()
      const pick = (asked ? ps.find((p) => p.id === asked || p.name.toLowerCase() === asked) : undefined) ?? ps.find((p) => p.id === saved) ?? ps.find((p) => p.admin && /president|ceo/i.test(p.title ?? '')) ?? ps.find((p) => p.admin) ?? ps[0] ?? null
      setMe(pick)
      // Warm the typeahead directory in the background so the first keystroke is instant.
      if (pick) import('@/components/omni/directory').then((m) => m.loadDirectory(slug, pick.id))
      try {
        if (pick && asked) localStorage.setItem(key(slug), pick.id)
      } catch {}
    })
  }, [slug])

  const signInAs = (id: string) => {
    const p = people.find((x) => x.id === id) ?? null
    setMe(p)
    try {
      if (p) localStorage.setItem(key(slug), p.id)
    } catch {}
  }

  return <Ctx.Provider value={{ slug, company, me, people, signInAs }}>{children}</Ctx.Provider>
}
