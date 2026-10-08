-- Search projection: the documents we index in Elasticsearch (passages cut from
-- evidence, entity cards, fact cards), kept in Postgres so the index can be rebuilt
-- at any time, plus an outbox that tells the projection worker what changed.

create table public.search_documents (
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  id                  text not null,                 -- 'p:<document_version>:<n>' | 'e:<entity>' | 'f:<fact>'
  doc_type            text not null check (doc_type in ('passage', 'entity', 'fact')),
  kind                text not null,                 -- evidence kind, entity type or fact kind
  title               text not null,
  content             text not null,
  source_object_id    uuid,
  document_version_id uuid,
  evidence_ids        uuid[] not null default '{}',
  entity_ids          uuid[] not null default '{}',
  acl_ids             uuid[] not null default '{}',  -- readable by anyone who can read one of these
  observed_at         timestamptz,
  valid_from          date,
  valid_to            date,
  is_current          boolean not null default true,
  authority           text,
  dedupe_key          text,
  citation            jsonb not null default '{}'::jsonb,
  content_hash        text not null,
  embedding           real[],
  embedded_hash       text,
  indexed_at          timestamptz,
  updated_at          timestamptz not null default now(),
  primary key (tenant_id, id)
);
create index search_documents_dv_idx on public.search_documents (tenant_id, document_version_id);
create index search_documents_entities_idx on public.search_documents using gin (entity_ids);
create index search_documents_acls_idx on public.search_documents using gin (acl_ids);
alter table public.search_documents enable row level security;
create policy search_documents_admin_read on public.search_documents
  for select to authenticated using (tenant_id in (select private.tenants_with_permission('tenant.manage')));

-- What changed since the last projection run. Triggers write here; the worker drains it.
create table public.search_outbox (
  id           bigint generated always as identity primary key,
  tenant_id    uuid not null references public.tenants (id) on delete cascade,
  kind         text not null check (kind in ('document_version', 'entity', 'fact', 'acl', 'source')),
  ref          uuid not null,
  created_at   timestamptz not null default now(),
  processed_at timestamptz
);
create index search_outbox_pending_idx on public.search_outbox (tenant_id, id) where processed_at is null;
alter table public.search_outbox enable row level security;

create or replace function private.search_outbox_note() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text := tg_argv[0];
  r jsonb := to_jsonb(coalesce(new, old));
begin
  insert into public.search_outbox (tenant_id, kind, ref)
  values (
    (r ->> 'tenant_id')::uuid,
    k,
    (case
      when k = 'document_version' and tg_table_name = 'evidence' then r ->> 'document_version_id'
      when k = 'entity' and tg_table_name = 'entity_aliases' then r ->> 'entity_id'
      when k = 'acl' then r ->> 'acl_id'
      else r ->> 'id'
    end)::uuid
  );
  return null;
end $$;

-- New or changed evidence (a new interview, a re-extracted policy) → re-cut that document.
create trigger search_outbox_evidence after insert or update of content, acl_id on public.evidence
  for each row execute function private.search_outbox_note('document_version');
-- Renames, merges and status changes; aliases added or rejected.
create trigger search_outbox_entities after update of canonical_name, status on public.entities
  for each row execute function private.search_outbox_note('entity');
create trigger search_outbox_aliases after insert or update of status, alias or delete on public.entity_aliases
  for each row execute function private.search_outbox_note('entity');
-- Canonical facts: accepted, corrected, superseded.
create trigger search_outbox_facts after insert or update of status, value, valid_from, valid_to on public.facts
  for each row when (coalesce(new.metadata, '{}'::jsonb) ->> 'layer' = 'canonical')
  execute function private.search_outbox_note('fact');
-- Permission changes: who is on an access list.
create trigger search_outbox_acl after insert or delete on public.acl_entries
  for each row execute function private.search_outbox_note('acl');
-- Files removed (documents.deleted_at) → drop their passages.
create trigger search_outbox_documents after update of deleted_at on public.documents
  for each row when (new.deleted_at is not null) execute function private.search_outbox_note('source');
