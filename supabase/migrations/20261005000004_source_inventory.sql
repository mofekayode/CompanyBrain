-- Company Brain: Phase 4 source inventory.
--
-- One row per raw object with its source and its profile (format, integrity,
-- embedded dates/people) flattened for filtering, plus duplicate counts.
-- security_invoker: the caller's RLS and ACLs apply, so the inventory never
-- reveals files a user cannot see.

create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to authenticated, service_role; -- already true on Supabase; explicit for any Postgres

-- Fuzzy / substring search over the original paths ("comp review", "S drive").
create index source_objects_path_trgm_idx
  on public.source_objects using gin (original_path extensions.gin_trgm_ops);

create view public.source_inventory
with (security_invoker = on) as
select
  so.id,
  so.tenant_id,
  so.source_id,
  s.name                                              as source_name,
  s.kind                                              as source_kind,
  s.is_legacy                                         as source_is_legacy,
  so.original_path,
  so.original_filename,
  so.size_bytes,
  so.sha256,
  so.mime_type,
  so.source_created_at,
  so.source_modified_at,
  so.source_owner,
  so.source_permissions,
  so.acl_id,
  so.status,
  so.deleted_at,
  so.s3_bucket,
  so.s3_key,
  p ->> 'format'                                      as format,
  p ->> 'category'                                    as category,
  p ->> 'structure'                                   as structure,
  (p ->> 'extension_matches')::boolean                as extension_matches,
  (p -> 'integrity' ->> 'ok')::boolean                as integrity_ok,
  p -> 'integrity' -> 'issues'                        as integrity_issues,
  (p -> 'dates' ->> 'earliest')::date                 as content_earliest,
  (p -> 'dates' ->> 'latest')::date                   as content_latest,
  p -> 'people'                                       as people,
  p -> 'document' ->> 'title'                         as document_title,
  p -> 'document' ->> 'author'                        as document_author,
  p -> 'document' ->> 'last_modified_by'              as document_last_modified_by,
  (p -> 'document' ->> 'likely_scanned')::boolean     as likely_scanned,
  (p ->> 'profiler_version')::int                     as profiler_version,
  dup.copies                                          as duplicate_copies,
  p                                                   as profile
from public.source_objects so
join public.sources s on s.tenant_id = so.tenant_id and s.id = so.source_id
cross join lateral (select so.metadata -> 'profile' as p) prof
cross join lateral (
  select count(*)::int as copies
  from public.source_objects o2
  where o2.tenant_id = so.tenant_id and o2.sha256 = so.sha256
) dup;

grant select on public.source_inventory to authenticated, service_role;
