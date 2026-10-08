-- Company Brain: evaluation sets.
--
-- Two kinds of items:
-- - data_check: a SQL assertion about the company model (resolution, counts,
--   facts, timelines, permissions) that must hold. Run by the service role.
-- - question: what a user might ask, with the expected answer, the files /
--   passages / entities a good search must retrieve, a category, and optionally
--   who is asking (persona) and as of when.
-- Each run stores per-item results so quality can be compared over time. For a
-- real client the truth comes from the client; for Riverton the evidence-derived
-- set is later checked against the hidden ground truth.

create table public.eval_sets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  name        text not null,
  description text,
  origin      text not null default 'ai' check (origin in ('ai', 'human', 'ground_truth')),
  created_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

create table public.eval_items (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  set_id          uuid not null,
  kind            text not null check (kind in ('data_check', 'question')),
  category        text not null,         -- lookup, alias, temporal, permission, multimodal, multi_hop, aggregation, exception, unanswerable, resolution, access
  question        text not null,         -- the question, or what the check asserts in words
  expected_answer text,
  expected        jsonb not null default '{}', -- {entities:[...], file_ids:[...], evidence_ids:[...], key_points:[...], values:{...}}
  check_sql       text,                  -- data_check: returns one row {passed boolean, detail text}
  persona_id      uuid,                  -- principal asking (permission questions)
  as_of           date,                  -- temporal questions
  difficulty      text check (difficulty in ('easy', 'medium', 'hard')),
  status          text not null default 'active' check (status in ('active', 'retired')),
  origin          text not null default 'ai' check (origin in ('ai', 'human', 'ground_truth')),
  notes           text,
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, set_id) references public.eval_sets (tenant_id, id) on delete cascade,
  foreign key (tenant_id, persona_id) references public.principals (tenant_id, id)
);
create index eval_items_set_idx on public.eval_items (set_id, kind, category);

create table public.eval_runs (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  set_id      uuid not null,
  target      text not null,             -- 'data', 'search:postgres', 'search:elastic', 'answer:agent', ...
  config      jsonb not null default '{}',
  summary     jsonb not null default '{}',
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  unique (tenant_id, id),
  foreign key (tenant_id, set_id) references public.eval_sets (tenant_id, id) on delete cascade
);

create table public.eval_results (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  run_id     uuid not null,
  item_id    uuid not null,
  passed     boolean,
  score      numeric(5, 4),
  output     jsonb not null default '{}',
  notes      text,
  created_at timestamptz not null default now(),
  primary key (run_id, item_id),
  foreign key (tenant_id, run_id) references public.eval_runs (tenant_id, id) on delete cascade,
  foreign key (tenant_id, item_id) references public.eval_items (tenant_id, id) on delete cascade
);

grant select, insert, update, delete on public.eval_sets, public.eval_items, public.eval_runs, public.eval_results to authenticated;
grant all on public.eval_sets, public.eval_items, public.eval_runs, public.eval_results to service_role;
revoke all on public.eval_sets, public.eval_items, public.eval_runs, public.eval_results from anon;
alter table public.eval_sets enable row level security;
alter table public.eval_items enable row level security;
alter table public.eval_runs enable row level security;
alter table public.eval_results enable row level security;

-- Evals are FDE material: only members who can write knowledge.
select private.apply_tenant_policies('eval_sets', 'knowledge.write', false);
select private.apply_tenant_policies('eval_items', 'knowledge.write', false);
select private.apply_tenant_policies('eval_runs', 'knowledge.write', false);
select private.apply_tenant_policies('eval_results', 'knowledge.write', false);
alter policy eval_sets_select on public.eval_sets using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
alter policy eval_items_select on public.eval_items using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
alter policy eval_runs_select on public.eval_runs using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
alter policy eval_results_select on public.eval_results using (tenant_id in (select private.tenants_with_permission('knowledge.write')));
