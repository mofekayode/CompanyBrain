-- Company Brain: sandbox role for agent-written SQL.
--
-- The workbench agent may run its own SELECTs over the source inventory. Those
-- queries run as workbench_agent, which can read only the inventory tables, and
-- RLS pins every row to the tenant set in app.tenant_id for that transaction.
-- The server additionally runs them read-only with a statement timeout.

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'workbench_agent') then
    create role workbench_agent nologin noinherit;
  end if;
end $$;

grant workbench_agent to postgres;
grant usage on schema public to workbench_agent;
grant usage on schema extensions to workbench_agent;
grant select on public.sources, public.source_objects, public.source_inventory to workbench_agent;

create policy sources_workbench_agent on public.sources for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy source_objects_workbench_agent on public.source_objects for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
