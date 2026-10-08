-- Company Brain: people & access.
--
-- The company map lives in principals (people = kind 'user', teams/departments/
-- branches = kind 'group'), built from the client's directory exports.
--
-- Every file belongs to one access scope (a named bucket with an audience and a
-- sensitivity). A scope owns one ACL. While a scope is held, its ACL has no
-- entries, so only roles with acl.bypass (owner/admin/fde) can read its files.
-- Releasing a scope fills the ACL with its audience. Individual grants (from
-- approved access requests) give a file its own ACL: scope audience + grantees.
-- Restricted scopes can be hidden: people without access do not even see that
-- their files exist.

-- ---------------------------------------------------------------------------
-- Company map: stable keys for directory-built principals
-- ---------------------------------------------------------------------------

create unique index principals_external_ref_key on public.principals (tenant_id, external_ref) where external_ref is not null;

-- ---------------------------------------------------------------------------
-- Scopes
-- ---------------------------------------------------------------------------

create table public.access_scopes (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  key          text not null,                 -- stable slug, e.g. 'hr-restricted'
  name         text not null,
  description  text,
  sensitivity  text not null check (sensitivity in ('internal', 'confidential', 'restricted')),
  hidden       boolean not null default false, -- people without access do not see the files exist
  status       text not null default 'held' check (status in ('held', 'released')),
  acl_id       uuid not null,
  origin       text not null default 'ai' check (origin in ('ai', 'human')),
  rules        jsonb not null default '[]',   -- [{source, path_prefix, why, evidence}]
  evidence     jsonb not null default '[]',   -- source-permission rows / files this scope is based on
  released_at  timestamptz,
  released_by  uuid,                          -- principal
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, key),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);

create table public.access_scope_audience (
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  scope_id     uuid not null,
  principal_id uuid not null,
  why          text,
  created_at   timestamptz not null default now(),
  primary key (scope_id, principal_id),
  foreign key (tenant_id, scope_id) references public.access_scopes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, principal_id) references public.principals (tenant_id, id) on delete cascade
);

-- One row per raw file: its scope, sensitivity, why, and the effective ACL.
create table public.file_access (
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  source_object_id uuid not null,
  scope_id         uuid not null,
  sensitivity      text not null check (sensitivity in ('internal', 'confidential', 'restricted')),
  reasons          jsonb not null default '[]', -- [{kind: rule|inherited|detector|ai|human, text, evidence?}]
  origin           text not null check (origin in ('rule', 'inherited', 'detector', 'ai', 'human')),
  flagged          boolean not null default false, -- needs FDE review (e.g. detector escalated it)
  acl_id           uuid not null,               -- scope ACL, or a per-file ACL when the file has grants
  updated_at       timestamptz not null default now(),
  primary key (source_object_id),
  unique (tenant_id, source_object_id),
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, scope_id) references public.access_scopes (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index file_access_scope_idx on public.file_access (tenant_id, scope_id);

-- ---------------------------------------------------------------------------
-- Requests, grants, audit
-- ---------------------------------------------------------------------------

create table public.access_requests (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  requester_id     uuid not null,             -- principal
  source_object_id uuid,
  scope_id         uuid,
  reason           text,
  status           text not null default 'pending' check (status in ('pending', 'approved', 'denied', 'cancelled')),
  grant_level      text check (grant_level in ('file', 'scope')),
  decided_by       uuid,                      -- principal
  decided_at       timestamptz,
  decision_note    text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check ((source_object_id is null) <> (scope_id is null)),
  foreign key (tenant_id, requester_id) references public.principals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, scope_id) references public.access_scopes (tenant_id, id) on delete cascade
);
create index access_requests_status_idx on public.access_requests (tenant_id, status, created_at desc);

create table public.access_grants (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  principal_id     uuid not null,
  source_object_id uuid,
  scope_id         uuid,
  request_id       uuid,
  granted_by       uuid,                      -- principal
  created_at       timestamptz not null default now(),
  unique (tenant_id, id),
  check ((source_object_id is null) <> (scope_id is null)),
  foreign key (tenant_id, principal_id) references public.principals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id) on delete cascade,
  foreign key (tenant_id, scope_id) references public.access_scopes (tenant_id, id) on delete cascade,
  foreign key (tenant_id, request_id) references public.access_requests (tenant_id, id)
);
create unique index access_grants_file_key on public.access_grants (principal_id, source_object_id) where source_object_id is not null;
create unique index access_grants_scope_key on public.access_grants (principal_id, scope_id) where scope_id is not null;

create table public.access_audit (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  actor_id   uuid,                            -- principal (null = system/FDE pipeline)
  action     text not null,                   -- scope.released, scope.held, request.created, request.approved, ...
  target     jsonb not null default '{}',
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index access_audit_tenant_idx on public.access_audit (tenant_id, created_at desc);

create trigger access_scopes_set_updated_at before update on public.access_scopes
for each row execute function private.set_updated_at();
create trigger file_access_set_updated_at before update on public.file_access
for each row execute function private.set_updated_at();
create trigger access_requests_set_updated_at before update on public.access_requests
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Grants and RLS
-- ---------------------------------------------------------------------------

grant select, insert, update, delete on public.access_scopes, public.access_scope_audience, public.file_access,
  public.access_requests, public.access_grants, public.access_audit to authenticated;
grant all on public.access_scopes, public.access_scope_audience, public.file_access,
  public.access_requests, public.access_grants, public.access_audit to service_role;
revoke all on public.access_scopes, public.access_scope_audience, public.file_access,
  public.access_requests, public.access_grants, public.access_audit from anon;

alter table public.access_scopes enable row level security;
alter table public.access_scope_audience enable row level security;
alter table public.file_access enable row level security;
alter table public.access_requests enable row level security;
alter table public.access_grants enable row level security;
alter table public.access_audit enable row level security;

-- The caller's principals: their own user principal plus every group it belongs to (recursively).
create function private.my_principal_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive mine (id) as (
    select p.id from public.principals p
    where p.user_id = auth.uid() and p.tenant_id in (select private.user_tenant_ids())
    union
    select pm.group_id from public.principal_members pm join mine on pm.member_id = mine.id
  )
  select id from mine
$$;
revoke all on function private.my_principal_ids() from public, anon;
grant execute on function private.my_principal_ids() to authenticated;

-- Scopes: managers see all; others see non-hidden scopes and scopes they can read.
select private.apply_tenant_policies('access_scopes', 'acl.manage', false);
alter policy access_scopes_select on public.access_scopes
  using (tenant_id in (select private.user_tenant_ids())
         and (tenant_id in (select private.tenants_with_permission('acl.manage'))
              or not hidden
              or acl_id in (select private.readable_acl_ids())));

select private.apply_tenant_policies('access_scope_audience', 'acl.manage', false);
alter policy access_scope_audience_select on public.access_scope_audience
  using (tenant_id in (select private.tenants_with_permission('acl.manage')));

-- A file's access row is visible when its scope is.
select private.apply_tenant_policies('file_access', 'acl.manage', false);
alter policy file_access_select on public.file_access
  using (scope_id in (select id from public.access_scopes));

-- Requests: anyone in the tenant may ask for themselves; managers see and decide all.
select private.apply_tenant_policies('access_requests', 'acl.manage', false);
alter policy access_requests_select on public.access_requests
  using (tenant_id in (select private.tenants_with_permission('acl.manage'))
         or requester_id in (select private.my_principal_ids()));
alter policy access_requests_insert on public.access_requests
  with check (tenant_id in (select private.user_tenant_ids())
              and requester_id in (select private.my_principal_ids())
              and status = 'pending' and decided_by is null);

select private.apply_tenant_policies('access_grants', 'acl.manage', false);
alter policy access_grants_select on public.access_grants
  using (tenant_id in (select private.tenants_with_permission('acl.manage'))
         or principal_id in (select private.my_principal_ids()));

select private.apply_tenant_policies('access_audit', 'acl.manage', false);
alter policy access_audit_select on public.access_audit
  using (tenant_id in (select private.tenants_with_permission('acl.manage')));

-- ---------------------------------------------------------------------------
-- The catalog a person sees: files they can open, plus locked files from scopes
-- that are not hidden. Hidden scopes' files are omitted entirely.
-- ---------------------------------------------------------------------------

create function public.file_catalog(p_tenant_id uuid)
returns table (
  id uuid, source_name text, original_path text, original_filename text, format text, size_bytes bigint,
  scope_id uuid, scope_name text, sensitivity text, can_open boolean, requested boolean
)
language sql stable security definer set search_path = '' as $$
  select so.id, s.name, so.original_path, so.original_filename, so.metadata -> 'profile' ->> 'format', so.size_bytes,
         sc.id, sc.name, fa.sensitivity,
         (fa.acl_id in (select private.readable_acl_ids())) as can_open,
         exists (select 1 from public.access_requests r
                 where r.status = 'pending' and r.requester_id in (select private.my_principal_ids())
                   and (r.source_object_id = so.id or r.scope_id = sc.id)) as requested
  from public.file_access fa
  join public.access_scopes sc on sc.id = fa.scope_id
  join public.source_objects so on so.id = fa.source_object_id
  join public.sources s on s.id = so.source_id
  where fa.tenant_id = p_tenant_id
    and p_tenant_id in (select private.user_tenant_ids())
    and (fa.acl_id in (select private.readable_acl_ids()) or not sc.hidden)
$$;
revoke all on function public.file_catalog(uuid) from public, anon;
grant execute on function public.file_catalog(uuid) to authenticated, service_role;
