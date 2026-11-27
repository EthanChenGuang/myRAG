import { isCanonicalTenantKey } from '@/lib/rag/backend/tenant-key';
import { parseTenantKey } from './embed';
import { mintScope, type TenantScope } from './scope';

/**
 * The scope for a vector-store write or scan. The key comes from a Supabase row read with the service role (outbox, sync reads,
 * reconcile), never from a request, and must already be canonical: a sync store may not repair a key, so a malformed one throws.
 */
export function storeScopeForTenantKey(tenantKey: string): TenantScope {
  if (!isCanonicalTenantKey(tenantKey)) throw new Error('[RAG Tenant] malformed tenant key');
  const parsed = parseTenantKey(tenantKey);
  if (!parsed) throw new Error('[RAG Tenant] malformed tenant key');
  if (parsed.kind === 'single') return mintScope('single', null, null);
  if (parsed.kind === 'org') return mintScope('org', null, parsed.organizationId);
  return mintScope('personal', parsed.userId, null);
}
