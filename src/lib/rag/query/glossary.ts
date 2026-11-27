import type { RpcClient } from '../backend/supabase-rpc';
import type { TenantScope } from '../tenant/scope';

export interface GlossaryPair {
  entryId: string;
  sourceLanguage: string;
  targetLanguage: string;
  sources: readonly string[];
  target: string;
}

export interface TenantGlossary {
  tenantKey: string;
  version: string;
  pairs: readonly GlossaryPair[];
}

export interface RequiredTranslation {
  entryId: string;
  sources: readonly string[];
  target: string;
}

export type GlossaryEnforcement = { status: 'ok'; text: string } | { status: 'corrected'; text: string; replacements: number } | { status: 'lost' };

export function requiredTranslations(
  _text: string,
  _sourceLanguage: string,
  _targetLanguage: string,
  _glossary: TenantGlossary | readonly GlossaryPair[] | null | undefined,
): RequiredTranslation[] {
  return [];
}

export function enforceGlossary(output: string, _required: readonly RequiredTranslation[]): GlossaryEnforcement {
  return { status: 'ok', text: output };
}

export async function loadTenantGlossary(_scope: TenantScope, _options: { signal?: AbortSignal; client?: RpcClient } = {}): Promise<TenantGlossary | null> {
  return null;
}
