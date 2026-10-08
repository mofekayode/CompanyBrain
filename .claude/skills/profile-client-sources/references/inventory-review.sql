-- Phase 4 review queries over public.source_inventory.
-- Replace :tenant with the tenant id (select id from tenants where slug = '<slug>').
-- Each query answers one or more of the Phase 4 questions in task.md.

-- Q1/Q3/Q6: per-source overview: size, shape, date span, issues, duplicates
select source_name, source_kind, count(*) files, pg_size_pretty(sum(size_bytes)) size,
  min(content_earliest) earliest, max(content_latest) latest,
  count(*) filter (where structure = 'structured') structured,
  count(*) filter (where structure = 'semi_structured') semi,
  count(*) filter (where structure = 'unstructured') unstructured,
  count(*) filter (where structure = 'media') media,
  count(*) filter (where not integrity_ok) issues,
  count(*) filter (where duplicate_copies > 1) dup_files,
  string_agg(distinct format, ',') formats
from source_inventory where tenant_id = :tenant
group by 1, 2 order by min(content_earliest) nulls last;

-- Q5: integrity issues, scans needing OCR, lock files (who had what open)
select 'issue' kind, source_name || ' / ' || original_path item, integrity_issues::text detail
  from source_inventory where tenant_id = :tenant and not integrity_ok
union all
select 'scanned', source_name || ' / ' || original_path, '' from source_inventory where tenant_id = :tenant and likely_scanned
union all
select 'lock', original_path, profile -> 'notes' ->> 0 from source_inventory where tenant_id = :tenant and format = 'office_lock'
order by 1, 2;

-- Q4: exact duplicates (same bytes, different paths)
select count(*) copies, string_agg(source_name || ' / ' || original_path, '  ||  ' order by original_path) paths
from source_inventory where tenant_id = :tenant and duplicate_copies > 1
group by sha256 order by 1 desc;

-- Q1/Q8: systems and people hiding in metadata: people, email domains, producing apps,
-- report preambles (which system produced an export), mailbox spans
select 'person' k, p.value #>> '{}' v, count(*) n
  from source_inventory, jsonb_array_elements(people) p where tenant_id = :tenant group by 2 having count(*) >= 2
union all
select 'domain', d.value #>> '{}', count(*)
  from source_inventory, jsonb_array_elements(profile -> 'email' -> 'domains') d where tenant_id = :tenant group by 2
union all
select 'app', profile -> 'document' ->> 'application', count(*)
  from source_inventory where tenant_id = :tenant and profile -> 'document' ->> 'application' is not null group by 2
union all
select 'preamble', original_path || ' :: ' || (profile -> 'table' -> 'preamble')::text, 1
  from source_inventory where tenant_id = :tenant and profile -> 'table' ? 'preamble'
union all
select 'mbox', original_path || ' :: ' || (profile -> 'email' ->> 'messages') || ' msgs '
    || coalesce(profile -> 'email' ->> 'first_date', '?') || '..' || coalesce(profile -> 'email' ->> 'last_date', '?'), 1
  from source_inventory where tenant_id = :tenant and format = 'mbox'
order by 1, 3 desc, 2;

-- Q1/Q2/Q9: every structured export with its columns: identify systems by column layout
select source_name, original_path, format, size_bytes,
  coalesce(profile -> 'table' ->> 'rows', profile -> 'email' ->> 'messages') n,
  left((profile -> 'table' -> 'columns')::text, 200) columns,
  profile -> 'table' -> 'date_columns' date_columns
from source_inventory
where tenant_id = :tenant and category in ('tabular_export', 'spreadsheet', 'calendar', 'archive', 'database', 'web_page')
order by source_name, original_path;

-- Q3: what drives "how far back": the oldest files and which evidence dated them
select source_name, original_path, format, content_earliest, profile -> 'dates' -> 'basis' basis
from source_inventory where tenant_id = :tenant and content_earliest is not null
order by content_earliest limit 25;

-- Q7: candidate permission exports (then read them: inheritance, labels, guests, links)
select source_name, original_path, profile -> 'table' -> 'columns' columns
from source_inventory
where tenant_id = :tenant and format = 'csv'
  and (original_path ilike '%permission%' or original_path ilike '%sharing%' or original_path ilike '%group%'
       or original_path ilike '%role%' or original_path ilike '%guest%' or original_path ilike '%users%');
