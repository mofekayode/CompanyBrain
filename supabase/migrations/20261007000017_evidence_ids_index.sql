-- "The files behind a fact" joins passages to facts on shared evidence (evidence_ids && ...).
-- Without an index every answer scanned the whole projection for each cited fact.
create index if not exists search_documents_evidence_idx on public.search_documents using gin (evidence_ids) where doc_type = 'passage';
