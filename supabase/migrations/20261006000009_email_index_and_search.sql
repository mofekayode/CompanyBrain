-- Company Brain: email threads and addresses (rebuilt from extracted email
-- documents), full-text search over evidence, and read access for the
-- workbench agent to extracted content.
--
-- Threads and addresses are derived data: rebuilt by the index_email job after
-- extraction. Address signals (internal, old domain, shared mailbox, possibly
-- former) are candidates for an FDE to confirm, not facts.

-- ---------------------------------------------------------------------------
-- Email threads
-- ---------------------------------------------------------------------------

create table public.email_threads (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references public.tenants (id) on delete cascade,
  thread_key        text not null,          -- root Message-ID, or 'subject:<normalized subject>'
  subject           text,
  first_at          timestamptz,
  last_at           timestamptz,
  message_count     integer not null,
  participants      text[] not null default '{}',  -- addresses
  has_attachments   boolean not null default false,
  has_forwarded     boolean not null default false,
  linked_by         text not null check (linked_by in ('headers', 'subject', 'single')),
  missing_messages  integer not null default 0,    -- referenced Message-IDs not in the corpus
  acl_id            uuid,                   -- shared by all messages; null when mixed or open
  mixed_acl         boolean not null default false,
  build_id          uuid not null,          -- index run that last wrote this row
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (tenant_id, id),
  unique (tenant_id, thread_key),
  foreign key (tenant_id, acl_id) references public.acls (tenant_id, id)
);
create index email_threads_tenant_last_idx on public.email_threads (tenant_id, last_at desc);

create table public.email_thread_messages (
  tenant_id          uuid not null references public.tenants (id) on delete cascade,
  thread_id          uuid not null,
  document_id        uuid not null,
  ordinal            integer not null,      -- chronological position in the thread
  depth              integer not null default 0,  -- reply depth (0 = root or unknown parent)
  parent_document_id uuid,
  sent_at            timestamptz,
  primary key (thread_id, document_id),
  foreign key (tenant_id, thread_id) references public.email_threads (tenant_id, id) on delete cascade,
  foreign key (tenant_id, document_id) references public.documents (tenant_id, id) on delete cascade
);
create index email_thread_messages_document_idx on public.email_thread_messages (tenant_id, document_id);

-- ---------------------------------------------------------------------------
-- Email addresses seen in the corpus, with candidate signals
-- ---------------------------------------------------------------------------

create table public.email_addresses (
  tenant_id        uuid not null references public.tenants (id) on delete cascade,
  address          text not null,
  domain           text not null,
  display_names    text[] not null default '{}',
  sent_count       integer not null default 0,
  received_count   integer not null default 0,
  first_seen_at    timestamptz,
  last_seen_at     timestamptz,
  internal         boolean not null default false,  -- on one of the client's own domains (candidate)
  domain_status    text check (domain_status in ('current', 'old')),  -- internal domains only
  role_mailbox     boolean not null default false,  -- info@, ar@, dispatch@ ...
  shared_mailbox   boolean not null default false,  -- role mailbox or several people sending as it
  possibly_former  boolean not null default false,  -- internal person who went quiet well before the corpus ends
  same_person_as   text[] not null default '{}',    -- likely aliases (same name/local part on another domain)
  signals          jsonb not null default '{}',     -- why each flag was set, with evidence ids
  build_id         uuid not null,
  updated_at       timestamptz not null default now(),
  primary key (tenant_id, address)
);
create index email_addresses_domain_idx on public.email_addresses (tenant_id, domain);

create trigger email_threads_set_updated_at before update on public.email_threads
for each row execute function private.set_updated_at();
create trigger email_addresses_set_updated_at before update on public.email_addresses
for each row execute function private.set_updated_at();

grant select, insert, update, delete on public.email_threads, public.email_thread_messages, public.email_addresses to authenticated;
grant all on public.email_threads, public.email_thread_messages, public.email_addresses to service_role;
revoke all on public.email_threads, public.email_thread_messages, public.email_addresses from anon;

alter table public.email_threads enable row level security;
alter table public.email_thread_messages enable row level security;
alter table public.email_addresses enable row level security;

select private.apply_tenant_policies('email_threads', 'ingestion.manage', true);
-- A thread whose messages carry different ACLs is visible only to people who manage ingestion;
-- everyone else sees the individual messages they are allowed to read.
alter policy email_threads_select on public.email_threads
  using (tenant_id in (select private.user_tenant_ids())
         and (acl_id is null or acl_id in (select private.readable_acl_ids()))
         and (not mixed_acl or tenant_id in (select private.tenants_with_permission('ingestion.manage'))));

select private.apply_tenant_policies('email_thread_messages', 'ingestion.manage', false);
-- A membership row is visible only when its message (document) is.
alter policy email_thread_messages_select on public.email_thread_messages
  using (document_id in (select id from public.documents) and thread_id in (select id from public.email_threads));

select private.apply_tenant_policies('email_addresses', 'ingestion.manage', false);

-- ---------------------------------------------------------------------------
-- Full-text search over evidence
-- ---------------------------------------------------------------------------

alter table public.evidence
  add column search_tsv tsvector generated always as (to_tsvector('english', content)) stored;
create index evidence_search_idx on public.evidence using gin (search_tsv);

-- ---------------------------------------------------------------------------
-- Workbench agent: read extracted content for its client only
-- ---------------------------------------------------------------------------

grant select on public.documents, public.document_versions, public.evidence,
                public.email_threads, public.email_thread_messages, public.email_addresses to workbench_agent;

create policy documents_workbench_agent on public.documents for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy document_versions_workbench_agent on public.document_versions for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy evidence_workbench_agent on public.evidence for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy email_threads_workbench_agent on public.email_threads for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy email_thread_messages_workbench_agent on public.email_thread_messages for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
create policy email_addresses_workbench_agent on public.email_addresses for select to workbench_agent
  using (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
