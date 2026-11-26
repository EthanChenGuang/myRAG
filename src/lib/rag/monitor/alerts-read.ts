import type { SupabaseClient } from '@supabase/supabase-js';
import type { MonitorAlert } from '@/lib/rag-eval/contracts.generated';

export type AlertStatusFilter = 'open' | 'acknowledged' | 'resolved' | 'active' | 'all';

export interface MonitorSummary {
  enabled: boolean;
  last_run_day: string | null;
  last_run_at: string | null;
  log_level: 'off' | 'ids' | 'masked_query';
  groups_checked: number | null;
  groups_insufficient: number | null;
}

export type ListAlertsResult =
  | { ok: true; alerts: MonitorAlert[]; counts: { open: number; acknowledged: number }; nextCursor: string | null; invalid: number }
  | { ok: false; reason: 'unavailable' | 'invalid_cursor' };

export async function listAlerts(
  _admin: Pick<SupabaseClient, 'from' | 'rpc'>,
  _input: { actorUserId: string; status: AlertStatusFilter; tenant?: string | null; limit: number; cursor?: string | null },
): Promise<ListAlertsResult> {
  return { ok: false, reason: 'unavailable' };
}

export async function monitorSummary(
  _admin: Pick<SupabaseClient, 'from'>,
): Promise<{ ok: true; monitor: MonitorSummary } | { ok: false; reason: 'unavailable' }> {
  return { ok: false, reason: 'unavailable' };
}
