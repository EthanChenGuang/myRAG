import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';

export type VisibilityResult = { ok: true; ids: ReadonlySet<string> } | { ok: false; reason: 'visibility_unavailable' | 'visibility_lookup_failed' };

export interface VisibilityOptions {
  admin?: RpcClient | null;
  signal?: AbortSignal;
}

export interface SecurityEventInput {
  event: 'citation_access_violation';
  chunkIds: readonly string[];
  documentIds: readonly string[];
  requestId?: string | null;
  userId?: string | null;
}

export async function visibleChunkIds(_scope: TenantScope, _ids: readonly string[], _options?: VisibilityOptions): Promise<VisibilityResult> {
  return { ok: false, reason: 'visibility_unavailable' };
}

export async function visibleDocumentIds(_scope: TenantScope, _ids: readonly string[], _options?: VisibilityOptions): Promise<VisibilityResult> {
  return { ok: false, reason: 'visibility_unavailable' };
}

export function createCitationRecheck(
  _scope: TenantScope,
  _options?: VisibilityOptions,
): ((chunkIds: readonly string[]) => Promise<ReadonlySet<string>>) | undefined {
  return undefined;
}

export async function recordSecurityEvent(_scope: TenantScope, _input: SecurityEventInput, _options?: VisibilityOptions): Promise<boolean> {
  return false;
}
