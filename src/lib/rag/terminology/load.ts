import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { getRagDeps } from '../deps';
import { scopeKey, type TenantScope } from '../tenant/scope';
import { buildMatcher, type TermEntry, type TerminologyMatcher } from './matcher';

/** D-22: the effective dictionary of one tenant key (translation pairs included) and both layer versions. */
export interface EffectiveDictionary {
  tenantKey: string;
  entries: readonly TermEntry[];
  sharedVersion: number;
  workspaceVersion: number;
  /** s<shared>[.w<workspace>]: the workspace part only when the tenant layer has a version. */
  version: string;
}

export interface LoadOptions {
  signal?: AbortSignal;
  /** Bypass and do not fill the cache (the preview endpoint). */
  bypassCache?: boolean;
  /** Tests: the service-role client and the clock. */
  client?: RpcClient;
  now?: () => number;
}

export const TERMINOLOGY_CACHE_MAX = 256;
export const TERMINOLOGY_CACHE_TTL_MS = 60_000;

interface CacheEntry {
  loadedAt: number;
  dictionary: EffectiveDictionary;
  matchers: Map<number, TerminologyMatcher>;
}

const cache = new Map<string, CacheEntry>();

export class TerminologyLoadError extends Error {
  constructor(message: string) {
    super(`[RAG Terminology] ${message}`);
    this.name = 'TerminologyLoadError';
  }
}

function serviceClient(options: LoadOptions): RpcClient {
  if (options.client) return options.client;
  const admin = getRagDeps().adminClient();
  if (!admin) throw new TerminologyLoadError('admin client unavailable');
  return admin as unknown as RpcClient;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function version(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

function toEntry(row: Record<string, unknown>): TermEntry | null {
  const entryId = text(row.entry_id);
  const canonical = text(row.canonical);
  const language = text(row.language);
  const kind = text(row.kind);
  if (!entryId || !canonical || !language || !kind) return null;
  return {
    entryId,
    layer: row.layer === 'workspace' ? 'workspace' : 'shared',
    canonical,
    variants: texts(row.variants),
    normalizedVariants: texts(row.normalized_variants),
    language,
    kind: kind as TermEntry['kind'],
    mode: row.mode === 'equivalent' ? 'equivalent' : 'one_way',
    sourceLanguage: text(row.source_language),
    targetLanguage: text(row.target_language),
  };
}

export function effectiveVersion(sharedVersion: number, workspaceVersion: number): string {
  return workspaceVersion > 0 ? `s${sharedVersion}.w${workspaceVersion}` : `s${sharedVersion}`;
}

async function fetchDictionary(tenantKey: string, options: LoadOptions): Promise<EffectiveDictionary> {
  let request = serviceClient(options).rpc('rag_term_effective', { p_tenant_key: tenantKey });
  if (options.signal) request = request.abortSignal(options.signal);
  const { data, error } = await request;
  if (error) throw new TerminologyLoadError(`rag_term_effective failed (${error.code ?? 'unknown'})`);
  const rows = rpcRows(data).filter((row): row is Record<string, unknown> => !!row && typeof row === 'object');
  const entries = rows.map(toEntry).filter((entry): entry is TermEntry => entry !== null);
  const sharedVersion = rows.length > 0 ? version(rows[0]!.shared_version) : 0;
  const workspaceVersion = rows.length > 0 ? version(rows[0]!.tenant_version) : 0;
  return { tenantKey, entries, sharedVersion, workspaceVersion, version: effectiveVersion(sharedVersion, workspaceVersion) };
}

function cached(tenantKey: string, now: number): CacheEntry | null {
  const entry = cache.get(tenantKey);
  if (!entry) return null;
  if (now - entry.loadedAt >= TERMINOLOGY_CACHE_TTL_MS) {
    cache.delete(tenantKey);
    return null;
  }
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  return entry;
}

function store(tenantKey: string, entry: CacheEntry): void {
  cache.delete(tenantKey);
  cache.set(tenantKey, entry);
  while (cache.size > TERMINOLOGY_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

async function cacheEntryFor(scope: TenantScope, options: LoadOptions): Promise<CacheEntry> {
  // The only tenant input is the minted scope; its key is both the RPC argument and the cache key (D-22, T-0411-13).
  const tenantKey = scopeKey(scope);
  const now = (options.now ?? getRagDeps().now)();
  if (!options.bypassCache) {
    const hit = cached(tenantKey, now);
    if (hit) return hit;
  }
  const entry: CacheEntry = { loadedAt: now, dictionary: await fetchDictionary(tenantKey, options), matchers: new Map() };
  if (!options.bypassCache) store(tenantKey, entry);
  return entry;
}

/** The effective dictionary of the scope's tenant, translation pairs included (the read API of plan 17 builds on this). */
export async function loadEffectiveDictionary(scope: TenantScope, options: LoadOptions = {}): Promise<EffectiveDictionary> {
  return (await cacheEntryFor(scope, options)).dictionary;
}

/** The dictionary and its matcher (built without translation pairs, D-32), cached with it. */
export async function terminologyMatcherFor(
  scope: TenantScope,
  options: LoadOptions & { minHanChars: number },
): Promise<{ dictionary: EffectiveDictionary; matcher: TerminologyMatcher }> {
  const entry = await cacheEntryFor(scope, options);
  let matcher = entry.matchers.get(options.minHanChars);
  if (!matcher) {
    matcher = buildMatcher(entry.dictionary.entries, { minHanChars: options.minHanChars });
    entry.matchers.set(options.minHanChars, matcher);
  }
  return { dictionary: entry.dictionary, matcher };
}

/** Drops one tenant key's cache entry, or every entry; the admin writers call it after a write (plan 09). */
export function invalidateTerminologyCache(tenantKey: string | 'all'): void {
  if (tenantKey === 'all') cache.clear();
  else cache.delete(tenantKey);
}

export function terminologyCacheSizeForTests(): number {
  return cache.size;
}
