-- Company Brain: tenancy, membership, principals, role permissions and ACLs.
--
-- Isolation model (Level 1): shared tables, tenant_id on every row, Postgres RLS.
-- Authorization has two layers:
--   1. Role permissions  - what a tenant member may *do* (permissions table, per tenant).
--   2. Resource ACLs     - what a tenant member may *see* (acls + acl_entries, referenced by acl_id).
--      A row with acl_id = null is visible to every member of its tenant.
--
-- Ingestion workers use the Supabase service_role, which bypasses RLS.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Shared trigger helpers
-- ---------------------------------------------------------------------------

create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

-- ---------------------------------------------------------------------------
-- Tenants and membership
-- ---------------------------------------------------------------------------

create type public.tenant_role as enum ('owner', 'admin', 'fde', 'member');

create table public.tenants (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name       text not null,
  status     text not null default 'active' check (status in ('active', 'suspended', 'archived')),
  settings   jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.tenant_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_id_idx on public.tenant_members (user_id);

-- What each role may do inside a tenant. Seeded from defaults on tenant creation,
-- then editable per tenant.
create table public.permissions (
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  role       public.tenant_role not null,
  permission text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, role, permission)
);

create table private.default_role_permissions (
  role       public.tenant_role not null,
  permission text not null,
  primary key (role, permission)
);

insert into private.default_role_permissions (role, permission)
select r.role::public.tenant_role, p.permission
from (values
  ('owner'), ('admin'), ('fde')
) as r (role)
cross join (values
  ('sources.manage'), ('ingestion.manage'), ('ontology.manage'), ('knowledge.write')
) as p (permission)
union all
select r.role::public.tenant_role, p.permission
from (values ('owner'), ('admin')) as r (role)
cross join (values ('members.manage'), ('acl.manage'), ('acl.bypass')) as p (permission)
union all
select 'owner', 'tenant.manage';

-- ---------------------------------------------------------------------------
-- Principals: anyone or anything an ACL can grant access to.
--   kind = 'user'  -> a platform user (user_id set) or a person known only from
--                     a source system, e.g. a former employee's mailbox (external_ref set)
--   kind = 'group' -> a platform group or a source-system group (e.g. SharePoint "HR")
-- ---------------------------------------------------------------------------

create table public.principals (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  kind         text not null check (kind in ('user', 'group')),
  user_id      uuid references auth.users (id) on delete cascade,
  external_ref text,
  display_name text not null,
  metadata     jsonb not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  unique (tenant_id, id),
  check (kind = 'user' or user_id is null)
);
create unique index principals_tenant_user_uidx on public.principals (tenant_id, user_id) where user_id is not null;
create unique index principals_tenant_external_ref_uidx on public.principals (tenant_id, external_ref) where external_ref is not null;
create index principals_user_id_idx on public.principals (user_id) where user_id is not null;

-- Group membership. Groups may contain groups; cycles are harmless.
create table public.principal_members (
  tenant_id  uuid not null,
  group_id   uuid not null,
  member_id  uuid not null,
  created_at timestamptz not null default now(),
  primary key (group_id, member_id),
  foreign key (tenant_id, group_id) references public.principals (tenant_id, id) on delete cascade,
  foreign key (tenant_id, member_id) references public.principals (tenant_id, id) on delete cascade,
  check (group_id <> member_id)
);
create index principal_members_member_id_idx on public.principal_members (member_id);

-- ---------------------------------------------------------------------------
-- ACLs. Resources reference an ACL by acl_id so that permission propagation
-- (raw file -> document -> evidence -> fact) is a copy of one id, and a source
-- permission change is an update to one ACL.
-- ---------------------------------------------------------------------------

create table public.acls (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  name       text not null,
  origin     jsonb not null default '{}', -- the source-system permissions this ACL was derived from
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id)
);

-- One row per principal allowed to read resources under an ACL (the resource_acl grants).
create table public.acl_entries (
  tenant_id    uuid not null,
  acl_id       uuid not null,
  principal_id uuid not null,
  created_at   timestamptz not null default now(),
  primary key (acl_id, principal_id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id) on delete cascade,
  foreign key (tenant_id, principal_id) references public.principals (tenant_id, id) on delete cascade
);
create index acl_entries_principal_id_idx on public.acl_entries (principal_id);

-- ---------------------------------------------------------------------------
-- Authorization helpers used by RLS policies.
-- They return sets so policies can use `x in (select ...)`, which Postgres
-- evaluates once per statement instead of once per row.
-- ---------------------------------------------------------------------------

create function private.user_tenant_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  where m.user_id = auth.uid()
    and t.status = 'active'
$$;

create function private.tenants_with_permission(p_permission text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select m.tenant_id
  from public.tenant_members m
  join public.tenants t on t.id = m.tenant_id
  join public.permissions p on p.tenant_id = m.tenant_id and p.role = m.role
  where m.user_id = auth.uid()
    and t.status = 'active'
    and p.permission = p_permission
$$;

create function private.has_permission(p_tenant_id uuid, p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from private.tenants_with_permission(p_permission) t where t = p_tenant_id
  )
$$;

-- Every ACL the current user may read through: direct grants, (nested) group
-- grants, and all ACLs of tenants where the user holds acl.bypass.
create function private.readable_acl_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  with recursive mine (id) as (
    select p.id
    from public.principals p
    where p.user_id = auth.uid()
      and p.tenant_id in (select private.user_tenant_ids())
    union
    select pm.group_id
    from public.principal_members pm
    join mine on pm.member_id = mine.id
  )
  select e.acl_id
  from public.acl_entries e
  join mine on mine.id = e.principal_id
  union
  select a.id
  from public.acls a
  where a.tenant_id in (select private.tenants_with_permission('acl.bypass'))
$$;

-- ---------------------------------------------------------------------------
-- Membership side effects: every member gets a user principal, so ACLs can
-- name them and groups can contain them.
-- ---------------------------------------------------------------------------

create function private.ensure_member_principal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.principals (tenant_id, kind, user_id, display_name)
  select new.tenant_id, 'user', new.user_id, coalesce(u.email, new.user_id::text)
  from auth.users u
  where u.id = new.user_id
  on conflict (tenant_id, user_id) where user_id is not null do nothing;
  return new;
end $$;

create trigger tenant_members_ensure_principal
after insert on public.tenant_members
for each row execute function private.ensure_member_principal();

-- ---------------------------------------------------------------------------
-- Tenant provisioning (service_role only).
-- ---------------------------------------------------------------------------

create function public.create_tenant(p_slug text, p_name text, p_owner_user_id uuid default null)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_tenant_id uuid;
begin
  insert into public.tenants (slug, name)
  values (p_slug, p_name)
  returning id into v_tenant_id;

  insert into public.permissions (tenant_id, role, permission)
  select v_tenant_id, d.role, d.permission
  from private.default_role_permissions d;

  if p_owner_user_id is not null then
    insert into public.tenant_members (tenant_id, user_id, role)
    values (v_tenant_id, p_owner_user_id, 'owner');
  end if;

  return v_tenant_id;
end $$;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

create trigger tenants_set_updated_at before update on public.tenants
for each row execute function private.set_updated_at();
create trigger tenant_members_set_updated_at before update on public.tenant_members
for each row execute function private.set_updated_at();
create trigger principals_set_updated_at before update on public.principals
for each row execute function private.set_updated_at();
create trigger acls_set_updated_at before update on public.acls
for each row execute function private.set_updated_at();
