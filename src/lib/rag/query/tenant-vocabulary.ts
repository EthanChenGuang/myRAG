import { createHash } from 'node:crypto';
import { getRagDeps } from '../deps';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { scopeKey, type TenantScope } from '../tenant/scope';

/** One active DATA-18 scope value of a tenant (3.2 D-38): the slug plus the admin-written label and aliases. */
export interface TenantVocabularyValue {
  dimension: string;
  slug: string;
  label: string;
  aliases: string[];
}

export interface TenantVocabularyDeps {
  adminClient: () => RpcClient | null;
  now: () => number;
}

const RPC_NAME = 'rag_scope_vocabulary_for';
const DOC_TYPES_RPC_NAME = 'rag_tenant_doc_types';
export const TENANT_VOCABULARY_CACHE_TTL_MS = 60 * 1000;
const CACHE_MAX = 256;

const cache = new Map<string, { values: TenantVocabularyValue[]; fetchedAt: number }>();
const docTypesCache = new Map<string, { values: string[]; fetchedAt: number }>();

function keyHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey, 'utf8').digest('hex').slice(0, 12);
}

function valuesFrom(data: unknown): TenantVocabularyValue[] {
  const values: TenantVocabularyValue[] = [];
  for (const row of rpcRows(data)) {
    if (typeof row !== 'object' || row === null) continue;
    const { dimension, value, label, aliases, active } = row as Record<string, unknown>;
    if (active !== true || typeof dimension !== 'string' || typeof value !== 'string' || typeof label !== 'string') continue;
    values.push({
      dimension,
      slug: value,
      label,
      aliases: Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string' && alias.trim() !== '') : [],
    });
  }
  return values;
}

function defaultDeps(): TenantVocabularyDeps {
  const deps = getRagDeps();
  return { adminClient: () => deps.adminClient() as unknown as RpcClient | null, now: deps.now };
}

function copy(values: readonly TenantVocabularyValue[]): TenantVocabularyValue[] {
  return values.map((value) => ({ ...value, aliases: [...value.aliases] }));
}

/**
 * The active scope vocabulary of the scope's tenant (D-03), on the admin client with scopeKey as the only tenant input
 * (the SQL reader asserts the key), cached per tenant key for 60 s. A failure answers null and is not cached, so the
 * completeness check simply runs without vocabulary terms. Logs carry a key hash, never a value.
 */
export async function loadTenantVocabulary(
  scope: TenantScope,
  options: { deps?: TenantVocabularyDeps; signal?: AbortSignal } = {},
): Promise<TenantVocabularyValue[] | null> {
  const tenantKey = scopeKey(scope);
  const deps = options.deps ?? defaultDeps();
  const now = deps.now();
  const hit = cache.get(tenantKey);
  if (hit && now - hit.fetchedAt < TENANT_VOCABULARY_CACHE_TTL_MS) return copy(hit.values);

  try {
    const client = deps.adminClient();
    if (!client) throw new Error('admin client unavailable');
    let request = client.rpc(RPC_NAME, { p_tenant_key: tenantKey });
    if (options.signal) request = request.abortSignal(options.signal);
    const { data, error } = await request;
    if (error) throw new Error(error.code ?? 'rpc_error');
    const values = valuesFrom(data);
    if (cache.size >= CACHE_MAX && !cache.has(tenantKey)) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(tenantKey, { values, fetchedAt: now });
    return copy(values);
  } catch (error) {
    const reason = error instanceof Error && /^[A-Za-z0-9_ ]{1,64}$/u.test(error.message) ? error.message : 'error';
    console.warn('[Query Layer] scope vocabulary unavailable; completeness runs without it', { tenant: keyHash(tenantKey), reason });
    return null;
  }
}

function docTypesFrom(data: unknown): string[] {
  const values: string[] = [];
  for (const row of rpcRows(data)) {
    if (typeof row !== 'object' || row === null) continue;
    const value = (row as Record<string, unknown>).doc_type;
    if (typeof value === 'string' && value.length > 0 && !values.includes(value)) values.push(value);
  }
  return values;
}

/**
 * The doc types of the scope's tenant's current, ready documents (0981, D-06): the doc-type vocabulary of sub-question
 * filters. Same rules as loadTenantVocabulary: admin client, scopeKey as the only tenant input, a 60 s cache per tenant key,
 * and null (not cached) on a failure, so the sub-question filters simply run without doc types.
 */
export async function loadTenantDocTypes(
  scope: TenantScope,
  options: { deps?: TenantVocabularyDeps; signal?: AbortSignal } = {},
): Promise<string[] | null> {
  const tenantKey = scopeKey(scope);
  const deps = options.deps ?? defaultDeps();
  const now = deps.now();
  const hit = docTypesCache.get(tenantKey);
  if (hit && now - hit.fetchedAt < TENANT_VOCABULARY_CACHE_TTL_MS) return [...hit.values];

  try {
    const client = deps.adminClient();
    if (!client) throw new Error('admin client unavailable');
    let request = client.rpc(DOC_TYPES_RPC_NAME, { p_tenant_key: tenantKey });
    if (options.signal) request = request.abortSignal(options.signal);
    const { data, error } = await request;
    if (error) throw new Error(error.code ?? 'rpc_error');
    const values = docTypesFrom(data);
    if (docTypesCache.size >= CACHE_MAX && !docTypesCache.has(tenantKey)) {
      const oldest = docTypesCache.keys().next().value;
      if (oldest !== undefined) docTypesCache.delete(oldest);
    }
    docTypesCache.set(tenantKey, { values, fetchedAt: now });
    return [...values];
  } catch (error) {
    const reason = error instanceof Error && /^[A-Za-z0-9_ ]{1,64}$/u.test(error.message) ? error.message : 'error';
    console.warn('[Query Layer] tenant doc types unavailable; sub-question filters run without them', { tenant: keyHash(tenantKey), reason });
    return null;
  }
}

/** Drops one tenant's entry, or every entry when no key is given (scope vocabulary and doc types). */
export function resetTenantVocabularyCacheForTests(tenantKey?: string): void {
  if (tenantKey === undefined) {
    cache.clear();
    docTypesCache.clear();
  } else {
    cache.delete(tenantKey);
    docTypesCache.delete(tenantKey);
  }
}
