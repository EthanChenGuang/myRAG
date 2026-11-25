import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';
import type { Lang } from './rewrite-gate';

export type KbLanguageShares = Partial<Record<Lang, number>>;

export interface KbLanguageDeps {
  adminClient: () => RpcClient | null;
  now: () => number;
}

export async function getKbLanguageShares(
  _scope: TenantScope,
  _options: { deps?: KbLanguageDeps; signal?: AbortSignal } = {},
): Promise<KbLanguageShares | null> {
  return null;
}

export function translationTargets(_queryLanguage: Lang, _shares: KbLanguageShares | null): Lang[] {
  return [];
}

export function resetKbLanguageCacheForTests(_tenantKey?: string): void {}
