import { rpcRows, type RpcClient } from '../../backend/supabase-rpc';
import { invalidateAttributeLexicon } from '../../retrieval/attributes';
import { invalidateHeaderTemplate } from '../attributes/header';
import { invalidateAttributeSchema } from '../attributes/schema';
import { getIngestDeps } from '../deps';
import { invalidateTenantRules } from './load';

/**
 * 03.3 G5 (hand-off 03.3-24-tenant-delete): a tenant delete removes the tenant's rows from the five Phase 3.3 rule and attribute tables
 * through rag_tenant_rule_data_delete (1009, service_role only), then drops this process's cached rules, schema, header template and
 * attribute lexicon for the key. Documents, chunks and the purge hooks are not touched here (Phase 6.3). Logs carry the rpc name and code only.
 */
const RPC = 'rag_tenant_rule_data_delete';
const LOG = '[RAG Tenant]';
const TENANT_KEY = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export type TenantRuleDataDeleteResult =
  | { ok: true; deleted: Record<string, number> }
  | { ok: false; reason: 'invalid_tenant_key' | 'unavailable' };

export async function deleteTenantRuleData(tenantKey: string, signal?: AbortSignal): Promise<TenantRuleDataDeleteResult> {
  if (typeof tenantKey !== 'string' || !TENANT_KEY.test(tenantKey)) return { ok: false, reason: 'invalid_tenant_key' };
  const db: RpcClient | null = getIngestDeps().db();
  if (!db) return { ok: false, reason: 'unavailable' };
  try {
    signal?.throwIfAborted();
    let request = db.rpc(RPC, { p_tenant_key: tenantKey });
    if (signal) request = request.abortSignal(signal);
    const response = await request;
    if (response.error) {
      const code = (response.error as { code?: string }).code ?? null;
      // Without migration 1009 the five Phase 3.3 tables do not exist either: nothing to delete.
      if (code === '42883' || code === 'PGRST202') return { ok: true, deleted: {} };
      console.error(`${LOG} tenant rule data delete failed`, { rpc: RPC, code: (response.error as { code?: string }).code ?? null });
      return { ok: false, reason: 'unavailable' };
    }
    const deleted: Record<string, number> = {};
    for (const row of rpcRows(response.data) as Array<Record<string, unknown>>) {
      if (typeof row.relation === 'string') deleted[row.relation] = Number(row.deleted ?? 0);
    }
    return { ok: true, deleted };
  } catch (error) {
    if (signal?.aborted) throw error;
    console.error(`${LOG} tenant rule data delete failed`, { rpc: RPC, error: error instanceof Error ? error.name : 'unknown' });
    return { ok: false, reason: 'unavailable' };
  } finally {
    invalidateTenantRules(tenantKey);
    invalidateAttributeSchema(tenantKey);
    invalidateHeaderTemplate(tenantKey);
    invalidateAttributeLexicon(tenantKey);
  }
}
