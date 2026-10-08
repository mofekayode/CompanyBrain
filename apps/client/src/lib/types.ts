export type FactStatus = 'current' | 'outdated' | 'disputed' | 'unknown' | 'check'
export interface Step {
  value: string
  when: string
  current: boolean
}
export interface PageFact {
  id: string
  subject?: string
  predicate: string
  value: string
  summary: string | null
  kind: string | null
  status: FactStatus
  from: string | null
  to: string | null
  timeline: Step[] | null
}
export interface BriefSource {
  n: number
  id: string
  title: string
  where: string
  kind: string
  status: 'current' | 'outdated' | 'disputed' | 'supporting' | 'related'
  file_id: string | null
  start_ms: number | null
  quote: string | null
}
export interface Brief {
  question: string
  headline: string | null
  detail: string | null
  timeline: Step[] | null
  changed: string | null
  also: { text: string; status: BriefSource['status']; cites: number[] }[]
  time: { mode: string; reading: string; as_of: string | null } | null
  entities: { id: string; name: string; type: string }[]
  sources: BriefSource[]
  restricted: { count: number; scopes: string[]; best_is_locked: boolean } | null
  conflicts: string[]
  evidence: 'strong' | 'partial' | 'weak'
  ms: number
  written: { text: string; model?: string; ms?: number } | null
}
export interface Person {
  id: string
  name: string
  title: string | null
  admin: boolean
}

export interface BriefStep {
  id: 'search' | 'fact' | 'history' | 'files' | 'access' | 'write'
  label: string
  status: 'active' | 'done'
  detail?: string
}
export type BriefPartial = Pick<Brief, 'question' | 'headline' | 'detail' | 'timeline' | 'changed' | 'time' | 'entities'>
