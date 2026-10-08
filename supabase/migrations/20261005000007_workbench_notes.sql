-- Company Brain: internal FDE notes saved from the workbench chat (e.g. discovery
-- summaries). Internal working material, never client-facing.

create table public.workbench_notes (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  title      text not null,
  body       text not null,                -- markdown
  kind       text not null default 'note' check (kind in ('note', 'discovery_summary')),
  session_id uuid,
  created_by uuid references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, session_id) references public.workbench_sessions (tenant_id, id) on delete set null (session_id)
);
create index workbench_notes_tenant_idx on public.workbench_notes (tenant_id, created_at desc);

create trigger workbench_notes_set_updated_at before update on public.workbench_notes
for each row execute function private.set_updated_at();

grant select, insert, update, delete on public.workbench_notes to authenticated;
grant all on public.workbench_notes to service_role;
revoke all on public.workbench_notes from anon;

alter table public.workbench_notes enable row level security;

-- FDE material: only members who can write knowledge (owner/admin/fde by default).
create policy workbench_notes_all on public.workbench_notes for all to authenticated
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')))
  with check (tenant_id in (select private.tenants_with_permission('knowledge.write')));
