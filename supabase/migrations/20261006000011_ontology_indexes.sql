-- Company Brain: indexes the company model needs at scale (100k+ entities), and
-- read access for the workbench agent to the model.

-- Foreign keys that are followed on delete/merge.
create index if not exists evidence_links_entity_idx on public.evidence_links (entity_id) where entity_id is not null;
create index if not exists evidence_links_relationship_idx on public.evidence_links (relationship_id) where relationship_id is not null;
create index if not exists evidence_links_fact_idx on public.evidence_links (fact_id) where fact_id is not null;
create index if not exists evidence_links_alias_idx on public.evidence_links (alias_id) where alias_id is not null;
create index if not exists evidence_links_evidence_idx on public.evidence_links (evidence_id);
create index if not exists entities_merged_into_idx on public.entities (merged_into_id) where merged_into_id is not null;
create index if not exists facts_supersedes_idx on public.facts (supersedes_fact_id) where supersedes_fact_id is not null;
create index if not exists relationships_type_idx on public.relationships (tenant_id, relationship_type_id);
create index if not exists entities_trgm_idx on public.entities using gin (lower(canonical_name) extensions.gin_trgm_ops);

-- The workbench agent reads the company model of its client only.
grant select on public.entity_types, public.relationship_types, public.entities, public.entity_aliases,
                public.entity_identifiers, public.relationships, public.facts, public.evidence_links to workbench_agent;

create policy entity_types_workbench_agent on public.entity_types for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy relationship_types_workbench_agent on public.relationship_types for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy entities_workbench_agent on public.entities for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy entity_aliases_workbench_agent on public.entity_aliases for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy entity_identifiers_workbench_agent on public.entity_identifiers for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy relationships_workbench_agent on public.relationships for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy facts_workbench_agent on public.facts for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy evidence_links_workbench_agent on public.evidence_links for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
