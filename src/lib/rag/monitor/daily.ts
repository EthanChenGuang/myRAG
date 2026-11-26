import type { SupabaseClient } from '@supabase/supabase-js';

export interface RunDailyOptions {
  now?: Date;
  source: 'cli' | 'route' | 'schedule';
  [key: string]: unknown;
}

export async function runDaily(_admin: SupabaseClient, _options: RunDailyOptions): Promise<Record<string, unknown>> {
  return { ran: false, reason: 'switched_off' };
}
