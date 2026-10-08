-- Company Brain: canonical knowledge.
--
-- Two layers in public.facts:
-- - claims: what one source says (an interview line, an email, a system field),
--   metadata.layer = 'claim'
-- - canonical facts: what the company model believes, metadata.layer = 'canonical',
--   each backed by the claims that support or contradict it (fact_claims).
-- Changes over time are chains (supersedes_fact_id + valid_from/valid_to); nothing is
-- overwritten, and every edit is versioned by the existing fact_versions trigger.

create table public.fact_claims (
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  canonical_id   uuid not null,
  claim_id       uuid not null,
  stance         text not null default 'supports' check (stance in ('supports', 'contradicts', 'context')),
  created_at     timestamptz not null default now(),
  primary key (canonical_id, claim_id),
  foreign key (tenant_id, canonical_id) references public.facts (tenant_id, id) on delete cascade,
  foreign key (tenant_id, claim_id) references public.facts (tenant_id, id) on delete cascade
);
create index fact_claims_claim_idx on public.fact_claims (claim_id);

grant select, insert, update, delete on public.fact_claims to authenticated;
grant all on public.fact_claims to service_role;
revoke all on public.fact_claims from anon;
alter table public.fact_claims enable row level security;

-- A link is visible when both facts are.
select private.apply_tenant_policies('fact_claims', 'knowledge.write', false);
alter policy fact_claims_select on public.fact_claims
  using (canonical_id in (select id from public.facts) and claim_id in (select id from public.facts));

grant select on public.fact_claims to workbench_agent;
create policy fact_claims_workbench_agent on public.fact_claims for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

create index facts_layer_idx on public.facts (tenant_id, (metadata ->> 'layer'), status);
