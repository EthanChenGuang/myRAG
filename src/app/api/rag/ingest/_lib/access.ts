import { accessGroupsEnabled, accessTableFilter, resolveAccessScope, scopeAccessFilter, scopeKey, type TenantScope } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export type IngestDocumentAccess = 'visible' | 'hidden' | 'unavailable';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uploaderOf(row: Record<string, unknown>): string | null {
  const state = row.processing_state;
  const fromState = state && typeof state === 'object' ? (state as Record<string, unknown>).uploaderId : null;
  const value = typeof fromState === 'string' ? fromState : typeof row.user_id === 'string' ? row.user_id : null;
  return value && UUID_RE.test(value) ? value.toLowerCase() : null;
}

/**
 * D-15: whether the caller may see the status of this document of the tenant: always while RAG_DOC_ACCESS_GROUPS is off; otherwise an
 * access admin, the uploader, or a caller whose keys overlap the document's label. A missing row is visible here so the status lookup
 * answers its own not-found; a lookup failure is unavailable (the route fails closed).
 */
export async function ingestDocumentAccess(
  scope: TenantScope,
  userId: string,
  documentId: string,
  signal: AbortSignal,
): Promise<IngestDocumentAccess> {
  if (!accessGroupsEnabled()) return 'visible';
  const resolved = await resolveAccessScope({ scope, identity: { kind: 'user', userId }, signal });
  if (!resolved.ok) return 'unavailable';
  const keys = accessTableFilter(scopeAccessFilter(resolved.scope));
  if (keys === null) return 'visible';
  const admin = getSupabaseAdmin();
  if (!admin) return 'unavailable';
  try {
    const { data, error } = await admin
      .from('documents')
      .select('access_groups, user_id, processing_state')
      .eq('id', documentId)
      .eq('tenant_key', scopeKey(scope))
      .abortSignal(signal)
      .maybeSingle();
    if (error) return 'unavailable';
    if (!data) return 'visible';
    const row = data as Record<string, unknown>;
    if (uploaderOf(row) === userId.toLowerCase()) return 'visible';
    const groups = Array.isArray(row.access_groups) ? (row.access_groups as unknown[]) : [];
    return groups.some((key) => typeof key === 'string' && keys.includes(key)) ? 'visible' : 'hidden';
  } catch {
    return 'unavailable';
  }
}
