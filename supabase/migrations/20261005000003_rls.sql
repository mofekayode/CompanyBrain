-- Company Brain: grants and row-level security.
--
-- Read:  tenant member, and the row's acl_id is null or readable (private.readable_acl_ids).
-- Write: tenant member whose role holds the permission for that area.
-- anon gets nothing. service_role (ingestion workers, provisioning) bypasses RLS.
--
-- Policy pattern `x in (select private.fn())` keeps the helper call uncorrelated,
-- so it runs once per statement rather than once per row.

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

grant usage on schema private to authenticated, service_role;
revoke all on all functions in schema private from public, anon;
grant execute on function
  private.user_tenant_ids(),
  private.tenants_with_permission(text),
  private.has_permission(uuid, text),
  private.readable_acl_ids()
to authenticated, service_role;

revoke all on function public.create_tenant(text, text, uuid) from public, anon, authenticated;
grant execute on function public.create_tenant(text, text, uuid) to service_role;

revoke all on all tables in schema public from anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant all on all tables in schema public to service_role;

-- Written only by trigger.
revoke insert, update, delete on public.fact_versions from authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS on every table
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'tenants', 'tenant_members', 'permissions', 'principals', 'principal_members', 'acls', 'acl_entries',
    'sources', 'source_objects', 'documents', 'document_versions', 'evidence',
    'entity_types', 'relationship_types', 'entities', 'entity_aliases', 'entity_identifiers',
    'relationships', 'facts', 'fact_versions', 'evidence_links', 'ingestion_jobs', 'sync_state'
  ] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;

-- Generates the standard policy set for a tenant-owned table:
--   select  -> member (+ ACL check when p_acl)
--   insert/update/delete -> holders of p_write_permission (omitted when null;
--   delete also omitted when p_allow_delete is false)
create function private.apply_tenant_policies(
  p_table text, p_write_permission text, p_acl boolean, p_allow_delete boolean default true)
returns void
language plpgsql set search_path = '' as $$
declare
  v_read text := 'tenant_id in (select private.user_tenant_ids())';
  v_write text := format('tenant_id in (select private.tenants_with_permission(%L))', p_write_permission);
begin
  if p_acl then
    v_read := v_read || ' and (acl_id is null or acl_id in (select private.readable_acl_ids()))';
  end if;

  execute format('create policy %I on public.%I for select to authenticated using (%s)',
                 p_table || '_select', p_table, v_read);

  if p_write_permission is not null then
    execute format('create policy %I on public.%I for insert to authenticated with check (%s)',
                   p_table || '_insert', p_table, v_write);
    execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
                   p_table || '_update', p_table, v_read || ' and ' || v_write, v_write);
    if p_allow_delete then
      execute format('create policy %I on public.%I for delete to authenticated using (%s)',
                     p_table || '_delete', p_table, v_read || ' and ' || v_write);
    end if;
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Tenancy tables
-- ---------------------------------------------------------------------------

create policy tenants_select on public.tenants for select to authenticated
  using (id in (select private.user_tenant_ids()));
create policy tenants_update on public.tenants for update to authenticated
  using (id in (select private.tenants_with_permission('tenant.manage')))
  with check (id in (select private.tenants_with_permission('tenant.manage')));

-- Members can see who else is in their tenant. Only tenant.manage can grant
-- or revoke 'owner', so an admin cannot promote themselves.
create policy tenant_members_select on public.tenant_members for select to authenticated
  using (tenant_id in (select private.user_tenant_ids()));
create policy tenant_members_insert on public.tenant_members for insert to authenticated
  with check (
    tenant_id in (select private.tenants_with_permission('members.manage'))
    and (role <> 'owner' or tenant_id in (select private.tenants_with_permission('tenant.manage')))
  );
create policy tenant_members_update on public.tenant_members for update to authenticated
  using (
    tenant_id in (select private.tenants_with_permission('members.manage'))
    and (role <> 'owner' or tenant_id in (select private.tenants_with_permission('tenant.manage')))
  )
  with check (
    tenant_id in (select private.tenants_with_permission('members.manage'))
    and (role <> 'owner' or tenant_id in (select private.tenants_with_permission('tenant.manage')))
  );
create policy tenant_members_delete on public.tenant_members for delete to authenticated
  using (
    tenant_id in (select private.tenants_with_permission('members.manage'))
    and (role <> 'owner' or tenant_id in (select private.tenants_with_permission('tenant.manage')))
  );

select private.apply_tenant_policies('permissions', 'tenant.manage', false);
select private.apply_tenant_policies('principals', 'acl.manage', false);
select private.apply_tenant_policies('principal_members', 'acl.manage', false);
select private.apply_tenant_policies('acls', 'acl.manage', false);
select private.apply_tenant_policies('acl_entries', 'acl.manage', false);

-- ---------------------------------------------------------------------------
-- Sources and raw evidence. Users never delete raw objects; ingestion runs as
-- service_role. ingestion.manage may adjust status / ACL assignments.
-- ---------------------------------------------------------------------------

select private.apply_tenant_policies('sources', 'sources.manage', false);
select private.apply_tenant_policies('source_objects', 'ingestion.manage', true, p_allow_delete => false);
select private.apply_tenant_policies('documents', 'ingestion.manage', true);
select private.apply_tenant_policies('document_versions', 'ingestion.manage', true);
select private.apply_tenant_policies('evidence', 'ingestion.manage', true);


-- ---------------------------------------------------------------------------
-- Ontology and knowledge
-- ---------------------------------------------------------------------------

select private.apply_tenant_policies('entity_types', 'ontology.manage', false);
select private.apply_tenant_policies('relationship_types', 'ontology.manage', false);
select private.apply_tenant_policies('entities', 'knowledge.write', true);
select private.apply_tenant_policies('relationships', 'knowledge.write', true);
select private.apply_tenant_policies('facts', 'knowledge.write', true);

-- Aliases and identifiers are as visible as the entity they name, so a
-- restricted entity's names do not leak.
select private.apply_tenant_policies('entity_aliases', 'knowledge.write', false);
select private.apply_tenant_policies('entity_identifiers', 'knowledge.write', false);
alter policy entity_aliases_select on public.entity_aliases
  using (entity_id in (select id from public.entities));
alter policy entity_identifiers_select on public.entity_identifiers
  using (entity_id in (select id from public.entities));

-- Fact history is as visible as the fact.
create policy fact_versions_select on public.fact_versions for select to authenticated
  using (fact_id in (select id from public.facts));

-- A link is visible only when its evidence is.
select private.apply_tenant_policies('evidence_links', 'knowledge.write', false);
alter policy evidence_links_select on public.evidence_links
  using (evidence_id in (select id from public.evidence));

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping: payloads can name restricted files, so only
-- ingestion.manage can read them.
-- ---------------------------------------------------------------------------

select private.apply_tenant_policies('ingestion_jobs', 'ingestion.manage', false);
select private.apply_tenant_policies('sync_state', 'ingestion.manage', false);
alter policy ingestion_jobs_select on public.ingestion_jobs
  using (tenant_id in (select private.tenants_with_permission('ingestion.manage')));
alter policy sync_state_select on public.sync_state
  using (tenant_id in (select private.tenants_with_permission('ingestion.manage')));

-- Migration-time helper only; nobody may call it at runtime.
revoke all on function private.apply_tenant_policies(text, text, boolean, boolean) from public, anon, authenticated;
