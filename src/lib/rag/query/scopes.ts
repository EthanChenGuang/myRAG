import type { RagConfig } from '../config';
import type { RpcClient } from '../backend/supabase-rpc';
import type { RetrievalFilterInput } from '../backend/types';
import type { TenantScope } from '../tenant/scope';

export type ScopeFilterErrorCode = 'scopes_disabled' | 'unknown_scope_value' | 'scope_vocabulary_unavailable';

export class ScopeFilterError extends Error {
  readonly code: ScopeFilterErrorCode;
  readonly status: number;

  constructor(code: ScopeFilterErrorCode, status: number, message: string) {
    super(message);
    this.name = 'ScopeFilterError';
    this.code = code;
    this.status = status;
  }
}

export async function resolveScopesFilter(
  filters: RetrievalFilterInput | undefined,
  _deps: { scope: TenantScope | null; config: RagConfig; client: RpcClient | null },
): Promise<RetrievalFilterInput | undefined> {
  return filters;
}
