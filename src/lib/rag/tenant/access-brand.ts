import { createHash } from 'node:crypto';

declare const accessBrand: unique symbol;

export type AccessScopeMode = 'off' | 'admin_all' | 'keys';

/** D-05: the caller's server-resolved access keys (all, g:<group uuid>, u:<user uuid>) and their set hash. */
export interface AccessScope {
  readonly [accessBrand]: true;
  readonly mode: AccessScopeMode;
  readonly keys: readonly string[];
  readonly setHash: string;
}

const ACCESS_KEY_RE = /^(all|[gu]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const minted = new WeakSet<object>();

/** SHA-256 hex of the sorted, de-duplicated keys joined by newlines; independent of key order. */
export function hashAccessKeys(keys: readonly string[]): string {
  const sorted = [...new Set(keys)].sort();
  return createHash('sha256').update(sorted.join('\n'), 'utf8').digest('hex');
}

/** Tenant-internal: only src/lib/rag/tenant resolves a caller's keys; tests may import it. */
export function mintAccessScope(mode: AccessScopeMode, keys: readonly string[]): AccessScope {
  if (mode !== 'off' && mode !== 'admin_all' && mode !== 'keys') {
    throw new Error('[RAG Access] unknown access mode');
  }
  const normalized = [...new Set(keys.map((key) => (typeof key === 'string' ? key.toLowerCase() : key)))];
  for (const key of normalized) {
    if (typeof key !== 'string' || !ACCESS_KEY_RE.test(key)) throw new Error('[RAG Access] invalid access key');
  }
  if (mode === 'keys' && normalized.length === 0) throw new Error('[RAG Access] keys mode needs at least one key');
  if (mode === 'off' && normalized.length > 0) throw new Error('[RAG Access] off mode takes no keys');
  const frozenKeys = Object.freeze([...normalized].sort());
  const access = Object.freeze({ mode, keys: frozenKeys, setHash: hashAccessKeys(frozenKeys) }) as unknown as AccessScope;
  minted.add(access);
  return access;
}

export function isAccessScope(value: unknown): value is AccessScope {
  return typeof value === 'object' && value !== null && minted.has(value);
}

export function assertAccessScope(value: unknown): asserts value is AccessScope {
  if (!isAccessScope(value)) {
    throw new Error('[RAG Access] unminted access scope');
  }
}
