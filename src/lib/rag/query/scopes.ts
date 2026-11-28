import { loadRagConfig, type RagConfig } from '../config';
import { getRagDeps } from '../deps';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import type { RetrievalFilterInput } from '../backend/types';
import { scopeKey, type TenantScope } from '../tenant/scope';

export type ScopeFilterErrorCode = 'scopes_disabled' | 'unknown_scope_value' | 'scope_vocabulary_unavailable';

/** A scopes filter the request may not use; routes answer `status` with `{ success: false, error: code, details }`. */
export class ScopeFilterError extends Error {
  readonly code: ScopeFilterErrorCode;
  readonly status: number;
  readonly details: { path: string; message: string }[];

  constructor(code: ScopeFilterErrorCode, status: number, message: string, details: { path: string; message: string }[] = []) {
    super(message);
    this.name = 'ScopeFilterError';
    this.code = code;
    this.status = status;
    this.details = details.length > 0 ? details : [{ path: 'scopes', message }];
  }
}

export function hasScopesFilter(filters: RetrievalFilterInput | undefined): boolean {
  return filters?.scopes !== undefined && filters.scopes.length > 0;
}

interface VocabularyRow {
  dimension?: unknown;
  value?: unknown;
  active?: unknown;
}

async function activeTags(client: RpcClient, tenantKey: string, signal?: AbortSignal): Promise<Set<string>> {
  const request = client.rpc('rag_scope_vocabulary_for', { p_tenant_key: tenantKey });
  const response = await (signal ? request.abortSignal(signal) : request);
  if (response.error) {
    console.error('[Document Search] scope vocabulary read failed:', { code: response.error.code ?? null });
    throw new ScopeFilterError('scope_vocabulary_unavailable', 503, 'the scope vocabulary is unavailable');
  }
  const tags = new Set<string>();
  for (const row of rpcRows(response.data) as VocabularyRow[]) {
    if (row.active === true && typeof row.dimension === 'string' && typeof row.value === 'string') {
      tags.add(`${row.dimension}:${row.value}`);
    }
  }
  return tags;
}

/**
 * D-39: a scopes filter only narrows the verified tenant scope. Refused while RAG_SCOPE_TAGS is off (scopes_disabled); every
 * value must be an active entry of that tenant's vocabulary (unknown_scope_value). A filter without scopes is returned as is.
 */
export async function resolveScopesFilter(
  filters: RetrievalFilterInput | undefined,
  deps: { scope: TenantScope | null; config?: RagConfig; client?: RpcClient | null; signal?: AbortSignal },
): Promise<RetrievalFilterInput | undefined> {
  if (!filters || !hasScopesFilter(filters)) return filters;
  const config = deps.config ?? loadRagConfig(getRagDeps().ragEnv());
  if (!config.scopeTags) {
    throw new ScopeFilterError('scopes_disabled', 400, 'scope filters are disabled (RAG_SCOPE_TAGS is off)');
  }
  const requested = [...new Set(filters.scopes)].sort();
  const known = deps.scope
    ? await (async () => {
        const client = deps.client === undefined ? (getRagDeps().adminClient() as unknown as RpcClient | null) : deps.client;
        if (!client) throw new ScopeFilterError('scope_vocabulary_unavailable', 503, 'the scope vocabulary is unavailable');
        return activeTags(client, scopeKey(deps.scope!), deps.signal);
      })()
    : new Set<string>();
  const unknown = requested.filter((tag) => !known.has(tag));
  if (unknown.length > 0) {
    throw new ScopeFilterError(
      'unknown_scope_value',
      400,
      'a scope value is not in the vocabulary',
      unknown.map((tag) => {
        const [dimension, value] = tag.split(':');
        return { path: `scopes.${dimension}`, message: `unknown scope value ${value}` };
      }),
    );
  }
  return { ...filters, scopes: requested };
}
