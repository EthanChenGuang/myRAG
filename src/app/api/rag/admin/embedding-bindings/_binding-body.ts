import type { BindingListEntry } from '@/lib/rag';

type Row = Omit<BindingListEntry, 'stale'>;

/** A binding row as the routes answer it: ids, status and audit fields, never the evidence body. */
export function bindingBody(row: Row): Record<string, unknown> {
  return {
    id: row.id,
    doc_type: row.docType,
    tenant_key: row.tenantKey,
    profile_id: row.profileId,
    status: row.status,
    has_evidence: row.hasEvidence,
    baseline_global_profile: row.baselineGlobalProfile,
    previous_binding_id: row.previousBindingId,
    activated_at: row.activatedAt,
    activated_by: row.activatedBy,
  };
}
