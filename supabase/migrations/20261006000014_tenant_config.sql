-- Per-tenant rule overrides (defaults live in code: packages/core/src/config/tenant-config.ts).
-- Append-only: every save is a new version; the newest version is in force.
create table public.tenant_config_versions (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  version    integer not null,
  overrides  jsonb not null default '{}'::jsonb,
  note       text,
  author     text not null default 'fde',
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);
alter table public.tenant_config_versions enable row level security;

create policy tenant_config_versions_read on public.tenant_config_versions
  for select to authenticated
  using (tenant_id in (select private.tenants_with_permission('tenant.manage')));
