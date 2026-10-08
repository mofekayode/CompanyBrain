-- Company Brain: shared semantic core.
--
-- Nothing here is specific to any customer. A tenant's business concepts
-- (Customer, Pump, WorkOrder, ...) are rows in entity_types / relationship_types,
-- and their attributes live in JSONB validated against the type's schema.
--
-- Every foreign key between tenant-owned tables is composite (tenant_id, id),
-- so a row can never reference another tenant's data, even via service_role.
--
-- Lineage: sources -> source_objects (immutable raw) -> documents/document_versions
--          -> evidence -> evidence_links -> entities / aliases / relationships / facts

-- ---------------------------------------------------------------------------
-- Sources and raw evidence
-- ---------------------------------------------------------------------------

-- A system or delivery the tenant's data came from: a SharePoint site, a file
-- server, a mailbox export, an accounting API, an interview programme.
create table public.sources (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id) on delete cascade,
  kind        text not null,               -- sharepoint, fileserver, mailbox, quickbooks, api, interview, upload, ...
  name        text not null,
  description text,
  connector   text,                        -- connector implementation that syncs it
  config      jsonb not null default '{}',
  is_legacy   boolean,                     -- null until profiling decides
  status      text not null default 'active' check (status in ('active', 'paused', 'retired')),
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, name)
);

-- One raw object exactly as received, stored under {tenant_id}/raw/ in S3.
-- Identity columns are immutable (see trigger below). Duplicates are kept:
-- the same bytes at two paths are two source_objects with the same sha256.
create table public.source_objects (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  source_id          uuid not null,
  parent_id          uuid,                 -- container: email for an attachment, zip for a member
  external_id        text,                 -- id in the source system (Message-ID, drive item id, API record id)
  original_path      text not null,
  original_filename  text not null,
  s3_bucket          text not null,
  s3_key             text not null,
  sha256             text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes         bigint not null check (size_bytes >= 0),
  mime_type          text,
  source_created_at  timestamptz,
  source_modified_at timestamptz,
  source_owner       text,
  source_permissions jsonb not null default '{}', -- permissions exactly as found in the source
  acl_id             uuid,                         -- effective platform ACL derived from them
  status             text not null default 'landed'
                     check (status in ('landed', 'profiled', 'processing', 'processed', 'failed', 'skipped')),
  deleted_at         timestamptz,                  -- deleted in the source; the raw copy is kept
  discovered_at      timestamptz not null default now(),
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, s3_key),
  foreign key (tenant_id, source_id) references public.sources (tenant_id, id),
  foreign key (tenant_id, parent_id) references public.source_objects (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index source_objects_sha256_idx on public.source_objects (tenant_id, sha256);
create index source_objects_path_idx on public.source_objects (tenant_id, source_id, original_path);
create index source_objects_parent_idx on public.source_objects (parent_id) where parent_id is not null;

create function private.protect_raw_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (new.tenant_id, new.source_id, new.parent_id, new.external_id, new.original_path,
      new.original_filename, new.s3_bucket, new.s3_key, new.sha256, new.size_bytes,
      new.source_created_at, new.source_modified_at, new.source_owner,
      new.source_permissions, new.discovered_at)
     is distinct from
     (old.tenant_id, old.source_id, old.parent_id, old.external_id, old.original_path,
      old.original_filename, old.s3_bucket, old.s3_key, old.sha256, old.size_bytes,
      old.source_created_at, old.source_modified_at, old.source_owner,
      old.source_permissions, old.discovered_at)
  then
    raise exception 'source_objects % is raw evidence; its provenance columns are immutable', old.id
      using errcode = 'check_violation';
  end if;
  return new;
end $$;

create trigger source_objects_protect_raw_identity
before update on public.source_objects
for each row execute function private.protect_raw_identity();

-- ---------------------------------------------------------------------------
-- Documents: logical items (a file, an email, an interview, an API record)
-- whose versions each point at one raw object.
-- ---------------------------------------------------------------------------

create table public.documents (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  source_id          uuid not null,
  kind               text not null,        -- file, email, transcript, video, spreadsheet, api_record, ...
  title              text,
  canonical_path     text,
  current_version_id uuid,
  acl_id             uuid,
  deleted_at         timestamptz,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, source_id) references public.sources (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index documents_source_idx on public.documents (tenant_id, source_id);

create table public.document_versions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  document_id        uuid not null,
  source_object_id   uuid not null,
  version_number     integer not null check (version_number > 0),
  version_created_at timestamptz,          -- when this version came into existence at the source
  processed_prefix   text,                 -- S3 prefix under {tenant_id}/processed/
  extractor          text,                 -- docling, assemblyai, email-parser, ...
  extractor_version  text,
  extraction_status  text not null default 'pending'
                     check (extraction_status in ('pending', 'processing', 'succeeded', 'failed', 'skipped')),
  extraction_error   text,
  page_count         integer,
  language           text,
  acl_id             uuid,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  unique (document_id, version_number),
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade,
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index document_versions_source_object_idx on public.document_versions (source_object_id);

alter table public.documents
  add foreign key (tenant_id, current_version_id)
  references public.document_versions (tenant_id, id)
  on delete set null (current_version_id);

-- ---------------------------------------------------------------------------
-- Evidence: the smallest citable unit - a chunk, table, OCR region,
-- transcript segment, video scene or API record - with an exact locator.
-- ---------------------------------------------------------------------------

create table public.evidence (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  document_version_id uuid not null,
  ordinal             integer not null,    -- position within the version
  kind                text not null check (kind in (
                        'text', 'table', 'ocr', 'email_body', 'transcript_segment',
                        'video_segment', 'image', 'api_record')),
  content             text not null,
  content_sha256      text,
  page_number         integer,
  section_path        text[],
  start_ms            integer,
  end_ms              integer,
  locator             jsonb not null default '{}', -- bbox, sheet, cell range, frame, char offsets, ...
  speaker             text,
  observed_at         timestamptz,         -- when the statement was made or recorded
  acl_id              uuid,
  metadata            jsonb not null default '{}',
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (document_version_id, ordinal),
  check (end_ms is null or start_ms is null or end_ms >= start_ms),
  foreign key (tenant_id, document_version_id) references public.document_versions (tenant_id, id) on delete cascade,
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);

-- ---------------------------------------------------------------------------
-- Ontology: tenant-defined types. AI proposes, FDE reviews.
-- ---------------------------------------------------------------------------

create table public.entity_types (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  name              text not null,
  description       text,
  parent_type_id    uuid,                  -- e.g. Pump is an Asset
  properties_schema jsonb not null default '{}', -- JSON Schema for entities.properties
  status            text not null default 'proposed' check (status in ('proposed', 'active', 'deprecated', 'rejected')),
  origin            text not null default 'human' check (origin in ('human', 'ai', 'import')),
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, parent_type_id) references public.entity_types (tenant_id, id)
);
create unique index entity_types_tenant_name_uidx on public.entity_types (tenant_id, lower(name));

create table public.relationship_types (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  name              text not null,
  description       text,
  source_type_id    uuid,                  -- null = any entity type
  target_type_id    uuid,
  is_symmetric      boolean not null default false,
  properties_schema jsonb not null default '{}',
  status            text not null default 'proposed' check (status in ('proposed', 'active', 'deprecated', 'rejected')),
  origin            text not null default 'human' check (origin in ('human', 'ai', 'import')),
  metadata          jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, source_type_id) references public.entity_types (tenant_id, id),
  foreign key (tenant_id, target_type_id) references public.entity_types (tenant_id, id)
);
create unique index relationship_types_tenant_name_uidx on public.relationship_types (tenant_id, lower(name));

-- ---------------------------------------------------------------------------
-- Entities, aliases and identifiers
-- ---------------------------------------------------------------------------

create table public.entities (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references public.tenants (id) on delete cascade,
  entity_type_id uuid not null,
  canonical_name text not null,
  description    text,
  properties     jsonb not null default '{}',
  status         text not null default 'candidate' check (status in ('candidate', 'active', 'merged', 'rejected')),
  merged_into_id uuid,
  valid_from     date,
  valid_to       date,
  confidence     numeric(4, 3) check (confidence between 0 and 1),
  acl_id         uuid,
  metadata       jsonb not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (tenant_id, id),
  check ((status = 'merged') = (merged_into_id is not null)),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  foreign key (tenant_id, entity_type_id) references public.entity_types (tenant_id, id),
  foreign key (tenant_id, merged_into_id) references public.entities (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index entities_type_idx on public.entities (tenant_id, entity_type_id);
create index entities_name_idx on public.entities (tenant_id, lower(canonical_name));

-- Every name a thing goes by. An ambiguous name ("Blue") gets one row per
-- candidate entity with is_ambiguous = true rather than being collapsed.
create table public.entity_aliases (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  entity_id        uuid not null,
  alias            text not null,
  normalized_alias text not null generated always as (lower(btrim(regexp_replace(alias, '\s+', ' ', 'g')))) stored,
  kind             text not null default 'name' check (kind in (
                     'name', 'nickname', 'former_name', 'abbreviation', 'system_spelling', 'misspelling', 'jargon')),
  is_ambiguous     boolean not null default false,
  context          jsonb not null default '{}', -- where the alias applies, e.g. {"location": "..."}
  valid_from       date,
  valid_to         date,
  confidence       numeric(4, 3) check (confidence between 0 and 1),
  status           text not null default 'candidate' check (status in ('candidate', 'confirmed', 'rejected')),
  origin           text not null default 'human' check (origin in ('human', 'ai', 'import')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (tenant_id, id),
  foreign key (tenant_id, entity_id) references public.entities (tenant_id, id) on delete cascade
);
create index entity_aliases_lookup_idx on public.entity_aliases (tenant_id, normalized_alias);
create index entity_aliases_entity_idx on public.entity_aliases (entity_id);

-- Exact system identifiers (QuickBooks id, serial number, employee file number).
-- Not unique: collisions are detected and reviewed, not silently rejected.
create table public.entity_identifiers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references public.tenants (id) on delete cascade,
  entity_id  uuid not null,
  system     text not null,
  value      text not null,
  valid_from date,
  valid_to   date,
  status     text not null default 'candidate' check (status in ('candidate', 'confirmed', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, id),
  unique (entity_id, system, value),
  foreign key (tenant_id, entity_id) references public.entities (tenant_id, id) on delete cascade
);
create index entity_identifiers_lookup_idx on public.entity_identifiers (tenant_id, system, value);

-- ---------------------------------------------------------------------------
-- Relationships
-- ---------------------------------------------------------------------------

create table public.relationships (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references public.tenants (id) on delete cascade,
  relationship_type_id uuid not null,
  source_entity_id     uuid not null,
  target_entity_id     uuid not null,
  properties           jsonb not null default '{}',
  valid_from           date,
  valid_to             date,
  confidence           numeric(4, 3) check (confidence between 0 and 1),
  status               text not null default 'candidate'
                       check (status in ('candidate', 'accepted', 'disputed', 'superseded', 'rejected')),
  acl_id               uuid,
  metadata             jsonb not null default '{}',
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  unique (tenant_id, id),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  foreign key (tenant_id, relationship_type_id) references public.relationship_types (tenant_id, id),
  foreign key (tenant_id, source_entity_id) references public.entities (tenant_id, id) on delete cascade,
  foreign key (tenant_id, target_entity_id) references public.entities (tenant_id, id) on delete cascade,
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index relationships_source_idx on public.relationships (tenant_id, source_entity_id);
create index relationships_target_idx on public.relationships (tenant_id, target_entity_id);

-- ---------------------------------------------------------------------------
-- Facts. Valid time (valid_from/valid_to) models change in the world:
-- "Net 30 until Jul 2025, then Net 60" is two facts, the first superseded.
-- fact_versions records every edit to a fact row, so corrections never
-- erase what was previously believed.
-- ---------------------------------------------------------------------------

create table public.facts (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  subject_entity_id  uuid not null,
  predicate          text not null,
  value              jsonb,                -- literal value
  object_entity_id   uuid,                 -- or another entity
  valid_from         date,
  valid_to           date,
  observed_at        timestamptz,          -- when the supporting evidence was stated/recorded
  authority          text,                 -- system_of_record, official_document, email, interview, inferred, ...
  confidence         numeric(4, 3) check (confidence between 0 and 1),
  status             text not null default 'candidate'
                     check (status in ('candidate', 'accepted', 'disputed', 'superseded', 'rejected', 'unknown')),
  supersedes_fact_id uuid,
  note               text,
  reviewed_by        uuid references auth.users (id),
  reviewed_at        timestamptz,
  acl_id             uuid,
  metadata           jsonb not null default '{}',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (tenant_id, id),
  check (value is not null or object_entity_id is not null or status = 'unknown'),
  check (valid_to is null or valid_from is null or valid_to >= valid_from),
  foreign key (tenant_id, subject_entity_id) references public.entities (tenant_id, id) on delete cascade,
  foreign key (tenant_id, object_entity_id) references public.entities (tenant_id, id) on delete cascade,
  foreign key (tenant_id, supersedes_fact_id) references public.facts (tenant_id, id),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index facts_subject_predicate_idx on public.facts (tenant_id, subject_entity_id, predicate);
create index facts_object_idx on public.facts (tenant_id, object_entity_id) where object_entity_id is not null;

create table public.fact_versions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null,
  fact_id       uuid not null,
  version       integer not null,
  snapshot      jsonb not null,            -- the full fact row after the change
  change_reason text,                      -- from the app.change_reason setting, if set
  changed_by    uuid,
  changed_at    timestamptz not null default now(),
  unique (fact_id, version),
  foreign key (tenant_id, fact_id) references public.facts (tenant_id, id) on delete cascade
);

create function private.record_fact_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.fact_versions (tenant_id, fact_id, version, snapshot, change_reason, changed_by)
  select new.tenant_id, new.id, coalesce(max(v.version), 0) + 1, to_jsonb(new),
         nullif(current_setting('app.change_reason', true), ''), auth.uid()
  from public.fact_versions v
  where v.fact_id = new.id;
  return null;
end $$;

create trigger facts_record_version
after insert or update on public.facts
for each row execute function private.record_fact_version();

-- ---------------------------------------------------------------------------
-- Evidence links: which evidence supports, contradicts or mentions which
-- piece of knowledge. Exactly one target per row.
-- ---------------------------------------------------------------------------

create table public.evidence_links (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  evidence_id     uuid not null,
  entity_id       uuid,
  alias_id        uuid,
  relationship_id uuid,
  fact_id         uuid,
  stance          text not null default 'supports' check (stance in ('supports', 'contradicts', 'mentions')),
  quote           text,                    -- exact supporting span
  locator         jsonb not null default '{}', -- span offsets within the evidence
  confidence      numeric(4, 3) check (confidence between 0 and 1),
  origin          text not null default 'human' check (origin in ('human', 'ai', 'import')),
  created_at      timestamptz not null default now(),
  unique (tenant_id, id),
  check (num_nonnulls(entity_id, alias_id, relationship_id, fact_id) = 1),
  foreign key (tenant_id, evidence_id) references public.evidence (tenant_id, id) on delete cascade,
  foreign key (tenant_id, entity_id) references public.entities (tenant_id, id) on delete cascade,
  foreign key (tenant_id, alias_id) references public.entity_aliases (tenant_id, id) on delete cascade,
  foreign key (tenant_id, relationship_id) references public.relationships (tenant_id, id) on delete cascade,
  foreign key (tenant_id, fact_id) references public.facts (tenant_id, id) on delete cascade
);
create index evidence_links_evidence_idx on public.evidence_links (evidence_id);
create index evidence_links_entity_idx on public.evidence_links (entity_id) where entity_id is not null;
create index evidence_links_alias_idx on public.evidence_links (alias_id) where alias_id is not null;
create index evidence_links_relationship_idx on public.evidence_links (relationship_id) where relationship_id is not null;
create index evidence_links_fact_idx on public.evidence_links (fact_id) where fact_id is not null;

-- ---------------------------------------------------------------------------
-- Ingestion bookkeeping
-- ---------------------------------------------------------------------------

create table public.ingestion_jobs (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references public.tenants (id) on delete cascade,
  job_type            text not null,       -- discover, copy_raw, classify, extract, normalize, enrich, resolve, project, ...
  idempotency_key     text not null,
  status              text not null default 'queued'
                      check (status in ('queued', 'running', 'succeeded', 'failed', 'dead', 'cancelled')),
  source_id           uuid,
  source_object_id    uuid,
  document_version_id uuid,
  parent_job_id       uuid,
  payload             jsonb not null default '{}',
  result              jsonb,
  priority            integer not null default 0,
  attempts            integer not null default 0,
  max_attempts        integer not null default 5,
  run_after           timestamptz not null default now(),
  locked_by           text,
  locked_at           timestamptz,
  started_at          timestamptz,
  finished_at         timestamptz,
  last_error          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, job_type, idempotency_key),
  foreign key (tenant_id, source_id) references public.sources (tenant_id, id),
  foreign key (tenant_id, source_object_id) references public.source_objects (tenant_id, id),
  foreign key (tenant_id, document_version_id) references public.document_versions (tenant_id, id),
  foreign key (tenant_id, parent_job_id) references public.ingestion_jobs (tenant_id, id)
);
create index ingestion_jobs_ready_idx on public.ingestion_jobs (priority desc, run_after) where status = 'queued';

-- Incremental-sync cursor per source stream (e.g. one mailbox, one API endpoint).
create table public.sync_state (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants (id) on delete cascade,
  source_id       uuid not null,
  stream          text not null default 'default',
  cursor          jsonb,
  status          text not null default 'idle' check (status in ('idle', 'running', 'error')),
  last_synced_at  timestamptz,
  last_success_at timestamptz,
  last_error      text,
  metadata        jsonb not null default '{}',
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (tenant_id, id),
  unique (source_id, stream),
  foreign key (tenant_id, source_id) references public.sources (tenant_id, id) on delete cascade
);

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'sources', 'source_objects', 'documents', 'document_versions', 'evidence',
    'entity_types', 'relationship_types', 'entities', 'entity_aliases', 'entity_identifiers',
    'relationships', 'facts', 'ingestion_jobs', 'sync_state'
  ] loop
    execute format(
      'create trigger %I before update on public.%I for each row execute function private.set_updated_at()',
      t || '_set_updated_at', t);
  end loop;
end $$;
