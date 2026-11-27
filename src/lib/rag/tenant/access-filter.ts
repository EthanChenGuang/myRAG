import { hashAccessKeys } from './access-brand';

// Pure access-filter helpers with no config or deps import, so modules such as the pgvector backend (and table-lookup through it)
// can use them without loading server env.

/**
 * A-14: the stable seam Phase 7 (07-38, 07-39) reads. The accessor name and the three shapes are a contract; renaming either breaks that
 * phase.
 */
export type ScopeAccessFilter =
  | { mode: 'off' }
  | { mode: 'admin_all' }
  | { mode: 'keys'; keys: readonly string[]; setHash: string };

/** Two filters describe the same access: same mode and, for keys, the same key set. */
export function sameAccessFilter(a: ScopeAccessFilter, b: ScopeAccessFilter): boolean {
  if (a.mode !== b.mode) return false;
  if (a.mode === 'keys' && b.mode === 'keys') return a.setHash === b.setHash && hashAccessKeys(a.keys) === b.setHash;
  return true;
}

/** The only place a filter becomes SQL arguments: off sends nothing, so the request body is today's. */
export function accessRpcArgs(filter: ScopeAccessFilter): { p_access_keys?: string[]; p_access_all?: boolean } {
  if (filter.mode === 'off') return {};
  if (filter.mode === 'admin_all') return { p_access_keys: ['all'], p_access_all: true };
  if (filter.keys.length === 0) throw new Error('[RAG Access] keys filter without keys');
  return { p_access_keys: [...filter.keys], p_access_all: false };
}
