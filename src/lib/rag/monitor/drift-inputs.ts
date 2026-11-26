import type { SupabaseClient } from '@supabase/supabase-js';

export async function driftInputs(_admin: SupabaseClient, _options: { tenantKey: string; now?: Date }): Promise<{
  window: { days: number; since: string; until: string };
  total: number;
  clusters: Array<{ id: string; n: number; share: number }>;
  slices: Array<Record<string, unknown> & { slice: string }>;
}> {
  return { window: { days: 0, since: '', until: '' }, total: -1, clusters: [], slices: [] };
}
