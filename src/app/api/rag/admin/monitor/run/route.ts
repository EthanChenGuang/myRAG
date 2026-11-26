import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { deliverStoredAlerts, monitorSettings, runDaily } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'The monitor run is unavailable' }, { status: 503, headers: NO_STORE });
}

/**
 * D-20, D-21: an admin runs the daily monitor job (aggregation, rules, alert upserts) and the alert delivery. 404 while
 * RAG_MONITOR is off, checked before the admin guard so nothing is queried. Returns counts only.
 */
export async function POST(request: Request): Promise<Response> {
  if (!monitorSettings().monitor) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
  }
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await runDaily(admin, { source: 'route' });
    if (!result.ran) {
      if (result.reason === 'config_invalid') return unavailable();
      return NextResponse.json(
        { success: true, ran: false, reason: result.reason, days_aggregated: 0, alerts_opened: 0, alerts_updated: 0 },
        { headers: NO_STORE },
      );
    }
    const delivery = await deliverStoredAlerts(admin);
    return NextResponse.json(
      {
        success: true,
        ran: true,
        day: result.day,
        days_aggregated: result.daysAggregated,
        alerts_opened: result.alertsOpened,
        alerts_updated: result.alertsUpdated,
        delivery: { alerts: delivery.alerts, webhook: delivery.channels.webhook, langfuse: delivery.channels.langfuse },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    const operation = (error as { operation?: unknown } | null)?.operation;
    console.error('[Monitor] run route failed', { operation: typeof operation === 'string' ? operation : 'unknown' });
    return unavailable();
  }
}
