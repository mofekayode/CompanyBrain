-- Company Brain: Phase 4.5 FDE workbench.
--
-- Discovery is run by an agent in a chat UI. Everything it does is stored:
-- sessions, the exact Claude messages (append-only, replayable), every step
-- (reasoning, tool call, result) and the findings it records against each
-- phase question, with evidence links to raw objects.

-- ---------------------------------------------------------------------------
-- Question catalog (global, per roadmap phase)
-- ---------------------------------------------------------------------------

create table public.discovery_questions (
  id         text primary key,             -- e.g. 'p4.systems'
  phase      text not null,                -- '4', '10', ...
  ordinal    integer not null,
  question   text not null,
  guidance   text,                         -- how to answer it from evidence
  created_at timestamptz not null default now(),
  unique (phase, ordinal)
);

insert into public.discovery_questions (id, phase, ordinal, question, guidance) values
  ('p4.systems',       '4', 1,  'Which systems exist?', 'Identify systems from export column layouts, report preambles, email domains, producing applications and folder names. Name the files and row counts that prove each one.'),
  ('p4.legacy',        '4', 2,  'Which systems are legacy?', 'Compare date ranges and overlaps between systems that hold the same kind of record. Say what replaced what and roughly when; label it a hypothesis.'),
  ('p4.history',       '4', 3,  'How far back does data go?', 'Use content and metadata dates (not copy timestamps). Report the oldest evidence per kind of record and which file dates it.'),
  ('p4.duplicates',    '4', 4,  'Which folders contain duplicates?', 'Use exact duplicates (same sha256) grouped by pile pairs; mention that near-duplicates need later work.'),
  ('p4.corrupted',     '4', 5,  'What appears corrupted?', 'Integrity issues, unreadable files, scans that need OCR, lock/system files. Explain each.'),
  ('p4.structured',    '4', 6,  'Which data is structured?', 'Exports, tables, calendars, databases: where the rows are and how many.'),
  ('p4.unstructured',  '4', 7,  'Which is unstructured?', 'Documents, PDFs, decks, notes, media: what kinds and where they cluster.'),
  ('p4.permissions',   '4', 8,  'Where are permission boundaries?', 'Read permission exports (SharePoint/mailbox/sharing/guest/admin) for unique permissions, sensitivity labels, personal drives, guests and external links.'),
  ('p4.key_people',    '4', 9,  'Which people''s files seem unusually important?', 'Rank people by metadata footprint: mail volume, authorship, lock files, personal piles. Key-person risk is a hypothesis.'),
  ('p4.authority',     '4', 10, 'What systems appear authoritative for what?', 'Per domain (work, money, people, identity, accounts, documents), which source looks like the system of record. Hypotheses only.');

-- ---------------------------------------------------------------------------
-- Sessions, messages, steps
-- ---------------------------------------------------------------------------

create table public.workbench_sessions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  title      text not null default 'New session',
  phase      text not null default '4',
  model      text,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);
create index workbench_sessions_tenant_idx on public.workbench_sessions (tenant_id, updated_at desc);

-- The exact message blocks exchanged with the model, in order. Append-only so a
-- session can be replayed and continued (thinking blocks must be passed back unchanged).
create table public.workbench_messages (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null,
  session_id uuid not null,
  ordinal    integer not null,
  role       text not null check (role in ('user', 'assistant')),
  content    jsonb not null,
  usage      jsonb,
  stop_reason text,
  created_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (session_id, ordinal),
  foreign key (tenant_id, session_id) references public.workbench_sessions (tenant_id, id) on delete cascade
);

-- What the agent did, step by step, for the trace UI.
create table public.workbench_steps (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null,
  session_id  uuid not null,
  turn        integer not null,             -- user turn this step belongs to
  ordinal     integer not null,
  kind        text not null check (kind in ('thinking', 'tool_call', 'text', 'error')),
  tool_name   text,
  tool_use_id text,
  input       jsonb,
  output      jsonb,
  summary     text,                         -- one-line human description for the trace
  status      text not null default 'ok' check (status in ('running', 'ok', 'error')),
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  unique (session_id, ordinal),
  foreign key (tenant_id, session_id) references public.workbench_sessions (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- Findings and their evidence
-- ---------------------------------------------------------------------------

create table public.discovery_findings (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  question_id text not null references public.discovery_questions (id),
  answer      text not null,                -- markdown
  status      text not null default 'hypothesis' check (status in ('hypothesis', 'confirmed', 'rejected', 'superseded')),
  confidence  numeric(4, 3) check (confidence between 0 and 1),
  session_id  uuid,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  review_note text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references public.workbench_sessions (tenant_id, id) on delete set null (session_id)
);
create index discovery_findings_question_idx on public.discovery_findings (tenant_id, question_id, created_at desc);

create table public.discovery_finding_evidence (
  tenant_id        uuid not null,
  finding_id       uuid not null,
  source_object_id uuid not null,
  note             text,                    -- what in this file supports the finding
  primary key (finding_id, source_object_id),
  foreign key (tenant_id, finding_id) references public.discovery_findings (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id)
);

do $$
declare
  t text;
begin
  foreach t in array array['workbench_sessions', 'discovery_findings'] loop
    execute format('create trigger %I before update on public.%I for each row execute function private.set_updated_at()', t || '_set_updated_at', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Grants and RLS (same model as the rest of the platform)
-- ---------------------------------------------------------------------------

grant select on public.discovery_questions to authenticated, service_role;
grant select, insert, update, delete on
  public.workbench_sessions, public.workbench_messages, public.workbench_steps,
  public.discovery_findings, public.discovery_finding_evidence
to authenticated;
grant all on
  public.discovery_questions, public.workbench_sessions, public.workbench_messages, public.workbench_steps,
  public.discovery_findings, public.discovery_finding_evidence
to service_role;
revoke all on
  public.discovery_questions, public.workbench_sessions, public.workbench_messages, public.workbench_steps,
  public.discovery_findings, public.discovery_finding_evidence
from anon;

alter table public.discovery_questions enable row level security;
alter table public.workbench_sessions enable row level security;
alter table public.workbench_messages enable row level security;
alter table public.workbench_steps enable row level security;
alter table public.discovery_findings enable row level security;
alter table public.discovery_finding_evidence enable row level security;

create policy discovery_questions_select on public.discovery_questions for select to authenticated using (true);

create policy workbench_sessions_select on public.workbench_sessions for select to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy workbench_sessions_write on public.workbench_sessions for all to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')))
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy workbench_messages_select on public.workbench_messages for select to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy workbench_messages_write on public.workbench_messages for insert to authenticated
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy workbench_steps_select on public.workbench_steps for select to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy workbench_steps_write on public.workbench_steps for all to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')))
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));

-- Findings are readable by every member; evidence only when the member can see the file.
create policy discovery_findings_select on public.discovery_findings for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
create policy discovery_findings_write on public.discovery_findings for all to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')))
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));
create policy discovery_finding_evidence_select on public.discovery_finding_evidence for select to authenticated
  using (source_object_id in (select id from public.source_objects));
create policy discovery_finding_evidence_write on public.discovery_finding_evidence for all to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')))
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));
