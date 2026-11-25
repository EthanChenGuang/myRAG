import type { SupabaseClient } from '@supabase/supabase-js';
import type { RetrievalLogLevel } from './config';

export type TenantRetrievalLog = 'inherit' | 'off' | 'ids';

export const SETTINGS_CACHE_TTL_MS = 60_000;

export interface EffectiveLogModeDeps {
  client?: SupabaseClient | null;
  globalLevel?: RetrievalLogLevel;
  now?: () => number;
  log?: (line: string) => void;
}

export function resetTenantSettingsCache(): void {}

export async function effectiveLogMode(_tenantKey: string, deps: EffectiveLogModeDeps = {}): Promise<RetrievalLogLevel> {
  return deps.globalLevel ?? 'off';
}

export async function setTenantFeedbackSettings(
  _client: SupabaseClient,
  _input: { tenantKey: string; retrievalLog: TenantRetrievalLog; updatedBy: string },
): Promise<Record<string, unknown>> {
  return {};
}
