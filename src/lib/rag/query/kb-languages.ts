import { createHash } from 'node:crypto';
import { getRagDeps } from '../deps';
import { rpcRows, type RpcClient } from '../backend/supabase-rpc';
import { scopeKey, type TenantScope } from '../tenant/scope';
import type { Lang } from './rewrite-gate';

export type KbLanguageShares = Partial<Record<Lang, number>>;

export interface KbLanguageDeps {
  adminClient: () => RpcClient | null;
  now: () => number;
}

const RPC_NAME = 'rag_tenant_language_shares';
export const KB_LANGUAGE_CACHE_TTL_MS = 10 * 60 * 1000;
/** D-23: the query language is rare at or below this share; a KB language is a target only above it. */
export const TRANSLATE_SHARE_THRESHOLD = 0.2;
const MAX_TARGETS = 2;
const LANGS: readonly Lang[] = ['zh', 'en', 'it'];

const cache = new Map<string, { shares: KbLanguageShares; fetchedAt: number }>();

function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (LANGS as readonly string[]).includes(value);
}

function keyHash(tenantKey: string): string {
  return createHash('sha256').update(tenantKey, 'utf8').digest('hex').slice(0, 12);
}

function sharesFrom(data: unknown): KbLanguageShares {
  const shares: KbLanguageShares = {};
  for (const row of rpcRows(data)) {
    if (typeof row !== 'object' || row === null) continue;
    const { language, share } = row as { language?: unknown; share?: unknown };
    const value = typeof share === 'string' ? Number(share) : share;
    if (!isLang(language) || typeof value !== 'number' || !Number.isFinite(value)) continue;
    shares[language] = value;
  }
  return shares;
}

function defaultDeps(): KbLanguageDeps {
  const deps = getRagDeps();
  return { adminClient: () => deps.adminClient() as RpcClient | null, now: deps.now };
}

/**
 * The tenant's knowledge-base language shares (D-23), cached per tenant key for 10 minutes. The key comes only from the
 * minted scope. Any failure answers null so translation simply does not fire; failures are not cached.
 */
export async function getKbLanguageShares(
  scope: TenantScope,
  options: { deps?: KbLanguageDeps; signal?: AbortSignal } = {},
): Promise<KbLanguageShares | null> {
  const tenantKey = scopeKey(scope);
  const deps = options.deps ?? defaultDeps();
  const now = deps.now();
  const hit = cache.get(tenantKey);
  if (hit && now - hit.fetchedAt < KB_LANGUAGE_CACHE_TTL_MS) return { ...hit.shares };

  try {
    const client = deps.adminClient();
    if (!client) throw new Error('admin client unavailable');
    let request = client.rpc(RPC_NAME, { p_tenant_key: tenantKey });
    if (options.signal) request = request.abortSignal(options.signal);
    const { data, error } = await request;
    if (error) throw new Error(error.code ?? 'rpc_error');
    const shares = sharesFrom(data);
    cache.set(tenantKey, { shares, fetchedAt: now });
    return { ...shares };
  } catch (error) {
    const reason = error instanceof Error && /^[A-Za-z0-9_ ]{1,64}$/u.test(error.message) ? error.message : 'error';
    console.warn('[Query Layer] KB language shares unavailable; translation skipped', { tenant: keyHash(tenantKey), reason });
    return null;
  }
}

/** D-23 / XLG-01: translate only when the query language's share is at most 20%, into the top two other languages above 20%. */
export function translationTargets(queryLanguage: Lang, shares: KbLanguageShares | null): Lang[] {
  if (!shares) return [];
  const known = LANGS.some((lang) => typeof shares[lang] === 'number');
  if (!known) return [];
  if ((shares[queryLanguage] ?? 0) > TRANSLATE_SHARE_THRESHOLD) return [];
  return LANGS.filter((lang) => lang !== queryLanguage && (shares[lang] ?? 0) > TRANSLATE_SHARE_THRESHOLD)
    .sort((a, b) => (shares[b] ?? 0) - (shares[a] ?? 0) || LANGS.indexOf(a) - LANGS.indexOf(b))
    .slice(0, MAX_TARGETS);
}

/** Drops one tenant's entry, or every entry when no key is given. */
export function resetKbLanguageCacheForTests(tenantKey?: string): void {
  if (tenantKey === undefined) cache.clear();
  else cache.delete(tenantKey);
}
