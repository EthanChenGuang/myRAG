import type { SupabaseClient } from '@supabase/supabase-js';

export async function storeDriftReport(_admin: SupabaseClient, _options: Record<string, unknown>): Promise<{ ok: false; reason: string; details: unknown[] }> {
  return { ok: false, reason: 'not_implemented', details: [] };
}

export async function latestDrift(_admin: SupabaseClient, _tenantKey: string, _config: unknown): Promise<any> {
  return {};
}
