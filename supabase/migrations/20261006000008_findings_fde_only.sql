-- Company Brain: discovery findings are internal FDE material (they cite
-- terminations, comp files, security gaps). Restrict reads to roles with
-- knowledge.write (owner/admin/fde by default), like workbench notes.

alter policy discovery_findings_select on public.discovery_findings
  using (tenant_id in (select private.tenants_with_permission('knowledge.write')));

alter policy discovery_finding_evidence_select on public.discovery_finding_evidence
  using (
    tenant_id in (select private.tenants_with_permission('knowledge.write'))
    and source_object_id in (select id from public.source_objects)
  );
