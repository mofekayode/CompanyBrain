// Tenant configuration: the rules and tuning the pipeline runs with for one client.
//
// - DEFAULT_RULES is the playbook every client starts from (what we learned so far).
// - A tenant stores only its *overrides* (tenant_config_versions, newest wins), so a
//   better default reaches every client that hasn't changed that rule.
// - `rulesFor` merges defaults + overrides and compiles the patterns; pipeline steps
//   call it once per run.
//
// What an FDE *learned* about a client (ontology, aliases, merges, scopes, mappings,
// evals) is exported separately by ./export.ts; that is data, not rules.

import type { Sql } from '../storage/raw'

/** A regular expression stored as JSON. */
export interface Pattern {
  pattern: string
  flags?: string
}

export interface TenantRules {
  /** Data cleaning when loading structured exports. */
  cleaning: {
    /** Cell values that mean "nobody / nothing". */
    placeholder_values: Pattern
    /** Comma lists of equipment-style codes to split into separate references. */
    code_list: Pattern
    /** Property columns that hold strong identifiers, and the identifier system they map to. */
    strong_id_columns: { column: Pattern; system: string }[]
    /** Words dropped when normalizing organisation names. */
    legal_suffixes: string[]
    /** First cells of a row that mark a report footer/banner, not data ("TOTAL", "Exported …"). */
    report_rows: Pattern
  }
  /** Entity resolution. */
  resolution: {
    /** Identifier systems where a shared value means "same thing" (merged without review). */
    strong_systems: string[]
    /** Shorter identifier values are too weak to merge on. */
    strong_min_length: number
    /** Types with at most this many entities are reviewed whole (catches jargon with no spelling overlap). */
    small_type_max: number
    /** Types with more entities only get certain merges. */
    max_fuzzy: number
    /** Largest group of similar names reviewed in one go. */
    max_component: number
  }
  /** Which source wins when statements disagree (higher wins). */
  authority: {
    rank: Record<string, number>
    /** Evidence kind → authority label for prose claims. */
    evidence_kind: Record<string, string>
    /** File paths that count as official documents (policies, SOPs, contracts, pricing…). */
    official_paths: Pattern
  }
  /** People and directory interpretation. */
  people: {
    /** Columns whose values never leave the file (pay, identity numbers, bank details). */
    sensitive_columns: Pattern
    inactive_status: Pattern
    service_account_names: Pattern
    non_person_account_types: Pattern
    /** Mailbox local parts that are roles, not people (dispatch@, billing@…). */
    role_mailboxes: Pattern
    group_display_names: Pattern
    former_min_sent: number
    former_quiet_days: number
    old_domain_days: number
  }
  /** Personal-data detectors that escalate files to restricted. */
  personal_data: {
    ssn: Pattern
    bank: Pattern
    dob: Pattern
    person_column: Pattern
    pay_column: Pattern
  }
  /** Client context added to AI prompts (examples in the client's own words). Empty = generic prompts. */
  prompts: {
    /** One paragraph: what the company does, its systems, its quirks. */
    company_context: string
    /** System names as the client says them ("FieldLine", "QuickBooks"). */
    system_examples: string[]
    /** In-house jargon examples ("hot job", "the cage"). */
    vocabulary_examples: string[]
  }
}

export const DEFAULT_RULES: TenantRules = {
  cleaning: {
    placeholder_values: { pattern: '^\\(?(unassigned|n\\/?a|none|null|nil|-+|tbd|unknown|no owner|not assigned|\\?+|0)\\)?$', flags: 'i' },
    code_list: { pattern: '^[A-Z]{1,6}-?\\d+[A-Z]?(\\s*,\\s*[A-Z]{1,6}-?\\d+[A-Z]?)+$' },
    strong_id_columns: [
      { column: { pattern: '^(serial( ?#| no\\.?| number)?|s\\/n)$', flags: 'i' }, system: 'Serial' },
      { column: { pattern: '^vin( \\(last 6\\)|6)?$', flags: 'i' }, system: 'VIN' },
    ],
    legal_suffixes: ['the', 'inc', 'llc', 'l l c', 'co', 'corp', 'corporation', 'company', 'ltd', 'limited', 'lp', 'llp', 'pllc'],
    report_rows: { pattern: '^(total|grand total|sub ?total|totals|exported\\b.*|report (run|generated)\\b.*|page \\d+( of \\d+)?)$', flags: 'i' },
  },
  resolution: { strong_systems: ['Serial', 'VIN', 'Email'], strong_min_length: 5, small_type_max: 25, max_fuzzy: 3000, max_component: 14 },
  authority: {
    rank: { system_of_record: 4, document: 3, official_document: 3, email: 2, interview: 1, video: 1, photo: 1 },
    evidence_kind: { transcript_segment: 'interview', video_segment: 'video', email_body: 'email', text: 'document', ocr: 'document', table: 'document', image: 'photo' },
    official_paths: { pattern: '(polic|sop|contract|agreement|handbook|pric|rate|terms|memo|procedure|plan|summary|addendum|exhibit|notice|letter)', flags: 'i' },
  },
  people: {
    sensitive_columns: {
      pattern: '(rate|pay|salary|wage|bonus|comp(ensation)?|ssn|social|tax|dob|birth|bank|routing|account ?(no|number|#)|iban|garnish|deduction|401k|benefit)',
      flags: 'i',
    },
    inactive_status: { pattern: '^(false|no|0|inactive|terminated|termed|deactivated|disabled|blocked|leave|separated|resigned|retired)$', flags: 'i' },
    service_account_names: { pattern: '\\b(admin|service|scanner|noreply|no-reply|test|shared|room|mailbox|printer|sync|bot)\\b', flags: 'i' },
    non_person_account_types: { pattern: '(shared|room|equipment|resource|service|scheduling|distribution)', flags: 'i' },
    role_mailboxes: {
      pattern:
        '^(info|sales|ar|ap|billing|accounts?|accounting|dispatch|service|support|office|admin|orders?|hr|payroll|no-?reply|donotreply|team|ops|operations|help|helpdesk|jobs|careers|parts|quotes?|invoices?|estimating|purchasing|receivables|payables|contact|hello|marketing|safety|shop|warehouse|scheduling|notifications?|alerts?|reports?)([._-].*)?$',
      flags: 'i',
    },
    group_display_names: { pattern: '\\b(team|techs?|staff|branch|all|everyone|group|dept|department|crew|mgmt|management|office)\\b', flags: 'i' },
    former_min_sent: 3,
    former_quiet_days: 120,
    old_domain_days: 90,
  },
  personal_data: {
    ssn: { pattern: '\\b(?!000|666|9\\d\\d)\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}\\b' },
    bank: { pattern: '\\b(routing|aba|account)\\s*(number|no\\.?|#)?\\s*[:#]?\\s*\\d{6,17}\\b', flags: 'i' },
    dob: { pattern: '\\b(date of birth|d\\.?o\\.?b\\.?|birth ?date)\\b\\s*[:\\-]?\\s*\\d{1,4}[/-]\\d{1,2}[/-]\\d{1,4}', flags: 'i' },
    person_column: { pattern: '(employee|name|first|last|worker|staff|tech(nician)?)', flags: 'i' },
    pay_column: {
      pattern: '^(rate|pay|pay rate|hourly( rate)?|salary|annual salary|wage|base( pay)?|bonus|compensation|comp|current comp|proposed( comp| salary)?|merit|increase)$',
      flags: 'i',
    },
  },
  prompts: { company_context: '', system_examples: [], vocabulary_examples: [] },
}

/** Deep partial: what a tenant stores. Arrays and patterns replace wholesale. */
export type RulesOverride = { [K in keyof TenantRules]?: Partial<TenantRules[K]> }

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && !('pattern' in (v as object))

/** Defaults + overrides. Objects merge key by key; arrays, patterns and scalars replace. */
export function mergeRules(base: TenantRules, over: RulesOverride | null | undefined): TenantRules {
  const out = structuredClone(base) as unknown as Record<string, Record<string, unknown>>
  for (const [section, values] of Object.entries(over ?? {})) {
    if (!values || !(section in out)) continue
    for (const [k, v] of Object.entries(values)) {
      if (v === undefined) continue
      const cur = out[section][k]
      out[section][k] = isPlain(cur) && isPlain(v) ? { ...cur, ...v } : v
    }
  }
  return out as unknown as TenantRules
}

/** Only the keys that differ from the defaults (what gets stored). */
export function diffRules(rules: TenantRules, base: TenantRules = DEFAULT_RULES): RulesOverride {
  const out: Record<string, Record<string, unknown>> = {}
  for (const section of Object.keys(base) as (keyof TenantRules)[]) {
    for (const [k, v] of Object.entries(rules[section] ?? {})) {
      if (JSON.stringify(v) !== JSON.stringify((base[section] as Record<string, unknown>)[k])) (out[section] ??= {})[k] = v
    }
  }
  return out as RulesOverride
}

export const re = (p: Pattern) => new RegExp(p.pattern, p.flags ?? '')

/** Patterns compiled once. */
export interface CompiledRules extends TenantRules {
  rx: {
    placeholder: RegExp
    codeList: RegExp
    reportRow: RegExp
    strongIdColumns: { column: RegExp; system: string }[]
    legalSuffix: RegExp
    officialPaths: RegExp
    sensitiveColumn: RegExp
    inactive: RegExp
    serviceAccount: RegExp
    nonPersonAccount: RegExp
    roleMailbox: RegExp
    groupName: RegExp
    ssn: RegExp
    bank: RegExp
    dob: RegExp
    personColumn: RegExp
    payColumn: RegExp
  }
}

export function compileRules(r: TenantRules): CompiledRules {
  return {
    ...r,
    rx: {
      placeholder: re(r.cleaning.placeholder_values),
      codeList: re(r.cleaning.code_list),
      reportRow: re(r.cleaning.report_rows),
      strongIdColumns: r.cleaning.strong_id_columns.map((s) => ({ column: re(s.column), system: s.system })),
      legalSuffix: new RegExp(`\\b(${r.cleaning.legal_suffixes.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'g'),
      officialPaths: re(r.authority.official_paths),
      sensitiveColumn: re(r.people.sensitive_columns),
      inactive: re(r.people.inactive_status),
      serviceAccount: re(r.people.service_account_names),
      nonPersonAccount: re(r.people.non_person_account_types),
      roleMailbox: re(r.people.role_mailboxes),
      groupName: re(r.people.group_display_names),
      ssn: re(r.personal_data.ssn),
      bank: re(r.personal_data.bank),
      dob: re(r.personal_data.dob),
      personColumn: re(r.personal_data.person_column),
      payColumn: re(r.personal_data.pay_column),
    },
  }
}

export const DEFAULTS: CompiledRules = compileRules(DEFAULT_RULES)

/** Checks every pattern compiles and numbers are sane; returns problems (empty = valid). */
export function validateRules(r: TenantRules): string[] {
  const problems: string[] = []
  const walk = (v: unknown, path: string) => {
    if (v && typeof v === 'object' && 'pattern' in v) {
      try {
        re(v as Pattern)
      } catch (error) {
        problems.push(`${path}: ${(error as Error).message}`)
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k)
  }
  walk(r, '')
  for (const [k, v] of Object.entries(r.resolution)) if (typeof v === 'number' && (!Number.isFinite(v) || v < 0)) problems.push(`resolution.${k}: must be a positive number`)
  for (const [k, v] of Object.entries(r.authority.rank)) if (!Number.isFinite(v)) problems.push(`authority.rank.${k}: must be a number`)
  return problems
}

const cache = new Map<string, { at: number; rules: CompiledRules }>()

/** The tenant's current overrides (null when it runs on defaults). */
export async function tenantOverrides(sql: Sql, tenantId: string): Promise<{ version: number; overrides: RulesOverride; note: string | null; created_at: string } | null> {
  const row = (
    await sql.query<{ version: number; overrides: RulesOverride; note: string | null; created_at: string }>(
      `select version, overrides, note, created_at::text from public.tenant_config_versions where tenant_id = $1 order by version desc limit 1`,
      [tenantId],
    )
  ).rows[0]
  return row ?? null
}

/** Effective rules for a tenant (defaults + overrides), cached for 30s. */
export async function rulesFor(sql: Sql, tenantId: string): Promise<CompiledRules> {
  const hit = cache.get(tenantId)
  if (hit && Date.now() - hit.at < 30_000) return hit.rules
  let rules = DEFAULTS
  try {
    const cur = await tenantOverrides(sql, tenantId)
    if (cur) rules = compileRules(mergeRules(DEFAULT_RULES, cur.overrides))
  } catch {
    // Table not there yet (older database) → defaults.
  }
  cache.set(tenantId, { at: Date.now(), rules })
  return rules
}

/** Saves a new version of the tenant's overrides (full replacement, history kept). */
export async function saveOverrides(sql: Sql, tenantId: string, overrides: RulesOverride, note: string, author = 'fde'): Promise<{ version: number; problems: string[] }> {
  const merged = mergeRules(DEFAULT_RULES, overrides)
  const problems = validateRules(merged)
  if (problems.length) return { version: 0, problems }
  const stored = diffRules(merged)
  const version = (
    await sql.query<{ version: number }>(
      `insert into public.tenant_config_versions (tenant_id, version, overrides, note, author)
       values ($1, coalesce((select max(version) from public.tenant_config_versions where tenant_id = $1), 0) + 1, $2, $3, $4) returning version`,
      [tenantId, JSON.stringify(stored), note, author],
    )
  ).rows[0].version
  cache.delete(tenantId)
  return { version, problems: [] }
}

/** Prompt lines with the client's own context (empty string when none). */
export function promptContext(r: TenantRules): string {
  const lines: string[] = []
  if (r.prompts.company_context) lines.push(`About this company: ${r.prompts.company_context}`)
  if (r.prompts.system_examples.length) lines.push(`Their systems are called: ${r.prompts.system_examples.join(', ')}.`)
  if (r.prompts.vocabulary_examples.length) lines.push(`Examples of their in-house terms: ${r.prompts.vocabulary_examples.map((v) => `"${v}"`).join(', ')}.`)
  return lines.join('\n')
}

/** Client context appended to a system prompt (nothing when the tenant has none). */
export const withContext = (r: TenantRules) => (promptContext(r) ? `\n\n${promptContext(r)}` : '')
