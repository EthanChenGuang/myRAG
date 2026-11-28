import type { RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { accessRpcArgs, scopeAccessFilter } from '../tenant/access';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { scheduleAfterResponse } from '../trace/schedule';

export type VisibilityResult = { ok: true; ids: ReadonlySet<string> } | { ok: false; reason: 'visibility_unavailable' | 'visibility_lookup_failed' };

export interface VisibilityOptions {
  /** Injected for tests; defaults to the service-role client. Null means no client and is a failure. */
  admin?: RpcClient | null;
  signal?: AbortSignal;
}

export interface SecurityEventInput {
  event: 'citation_access_violation';
  chunkIds: readonly string[];
  documentIds: readonly string[];
  requestId?: string | null;
  /** Defaults to the scope's user. */
  userId?: string | null;
}

function adminOf(options?: VisibilityOptions): RpcClient | null {
  if (options?.admin !== undefined) return options.admin;
  return getRagDeps().adminClient() as unknown as RpcClient | null;
}

function idOf(row: unknown): string | null {
  if (typeof row === 'string') return row.toLowerCase();
  if (typeof row === 'object' && row !== null) {
    const values = Object.values(row as Record<string, unknown>);
    if (values.length === 1 && typeof values[0] === 'string') return values[0].toLowerCase();
  }
  return null;
}

async function visible(
  fn: 'rag_chunks_visible' | 'rag_documents_visible',
  idArg: 'p_chunk_ids' | 'p_document_ids',
  scope: TenantScope,
  ids: readonly string[],
  options?: VisibilityOptions,
): Promise<VisibilityResult> {
  const filter = scopeAccessFilter(scope);
  const asked = [...new Set(ids.filter((id): id is string => typeof id === 'string').map((id) => id.toLowerCase()))];
  if (filter.mode === 'off') return { ok: true, ids: new Set(asked) };
  if (asked.length === 0) return { ok: true, ids: new Set() };
  const admin = adminOf(options);
  if (!admin) {
    console.warn('[RAG Access] visibility check unavailable', { fn });
    return { ok: false, reason: 'visibility_unavailable' };
  }
  try {
    const request = admin.rpc(fn, { p_tenant_key: scopeKey(scope), [idArg]: asked, ...accessRpcArgs(filter) });
    const { data, error } = await (options?.signal ? request.abortSignal(options.signal) : request);
    if (error || !Array.isArray(data)) throw new Error('lookup');
    const askedSet = new Set(asked);
    const out = new Set<string>();
    for (const row of data) {
      const id = idOf(row);
      if (id !== null && askedSet.has(id)) out.add(id);
    }
    return { ok: true, ids: out };
  } catch {
    console.warn('[RAG Access] visibility check failed', { fn, count: asked.length });
    return { ok: false, reason: 'visibility_lookup_failed' };
  }
}

/** D-26: which of these chunks the scope's caller may see (current, ready, tenant, labels); one batched call; never unchecked ids on error. */
export function visibleChunkIds(scope: TenantScope, chunkIds: readonly string[], options?: VisibilityOptions): Promise<VisibilityResult> {
  return visible('rag_chunks_visible', 'p_chunk_ids', scope, chunkIds, options);
}

/** D-15, D-27: which of these documents (any version) the scope's caller may see; one batched call. */
export function visibleDocumentIds(scope: TenantScope, documentIds: readonly string[], options?: VisibilityOptions): Promise<VisibilityResult> {
  return visible('rag_documents_visible', 'p_document_ids', scope, documentIds, options);
}

/**
 * D-26: the citation recheck for a scope; undefined with access off (no transform is added). The function resolves to the visible chunk
 * ids and rejects when the check cannot run, so the caller drops every citation.
 */
export function createCitationRecheck(
  scope: TenantScope,
  options?: VisibilityOptions,
): ((chunkIds: readonly string[]) => Promise<ReadonlySet<string>>) | undefined {
  if (scopeAccessFilter(scope).mode === 'off') return undefined;
  return async (chunkIds) => {
    const result = await visibleChunkIds(scope, chunkIds, options);
    if (!result.ok) throw new Error('[RAG Access] citation recheck failed');
    return result.ids;
  };
}

/** D-26: records a security event with ids only, meant for after the response; false when the write failed. */
export async function recordSecurityEvent(scope: TenantScope, input: SecurityEventInput, options?: VisibilityOptions): Promise<boolean> {
  scopeAccessFilter(scope);
  const admin = adminOf(options);
  if (!admin) {
    console.warn('[RAG Access] security_event_failed', { reason: 'admin_client_missing' });
    return false;
  }
  try {
    const request = admin.rpc('rag_security_event_record', {
      p_tenant_key: scopeKey(scope),
      p_user_id: input.userId === undefined ? scope.userId : input.userId,
      p_event: input.event,
      p_chunk_ids: [...input.chunkIds],
      p_document_ids: [...input.documentIds],
      p_request_id: input.requestId ?? null,
    });
    const { error } = await (options?.signal ? request.abortSignal(options.signal) : request);
    if (error) throw new Error('write');
    return true;
  } catch {
    console.warn('[RAG Access] security_event_failed', { event: input.event, chunks: input.chunkIds.length, documents: input.documentIds.length });
    return false;
  }
}

/** D-26: writes the security event after the response (never on the answer path); ids only. */
export function scheduleSecurityEvent(scope: TenantScope, input: SecurityEventInput, options?: VisibilityOptions): void {
  scheduleAfterResponse(async () => {
    await recordSecurityEvent(scope, input, options);
  });
}
