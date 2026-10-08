-- Typeahead: nicknames, jargon and former names ("Big Blue", "J-town") match as you type,
-- and email subjects / file names are found by partial words.
create index if not exists entity_aliases_trgm_idx on public.entity_aliases using gin (lower(alias) extensions.gin_trgm_ops);
create index if not exists search_documents_title_trgm_idx on public.search_documents using gin (lower(title) extensions.gin_trgm_ops) where doc_type = 'passage';
create index if not exists source_objects_filename_trgm_idx on public.source_objects using gin (lower(original_filename) extensions.gin_trgm_ops);
