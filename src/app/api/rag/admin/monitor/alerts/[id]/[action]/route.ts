import { NextResponse } from 'next/server';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { alertForAdmin } from '@/lib/rag/monitor/alerts-read';
import { setAlertStatus } from '@/lib/rag/monitor/alerts-store';
import { monitorSettings } from '@/lib/rag/monitor/config';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS = { acknowledge: 'acknowledged', resolve: 'resolved' } as const;

type Action = keyof typeof ACTIONS;

function isAction(value: string): value is Action {
  return Object.prototype.hasOwnProperty.call(ACTIONS, value);
}

function answer(status: 400 | 404 | 409 | 503, error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status, headers: NO_STORE });
}

/**
 * D-22, UI-SPEC 6.7: acknowledge (open to acknowledged) or resolve (open or acknowledged to resolved) one alert of a tenant the
 * verified admin administers. Another tenant's alert answers 404, a transition the alert's state does not allow 409.
 * rag_monitor_alert_set_status records the actor and the time.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string; action: string }> }): Promise<Response> {
  if (!monitorSettings().monitor) return answer(404, 'Not found');
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const { id, action } = await context.params;
  if (!isAction(action)) return answer(404, 'Not found');
  if (!UUID_RE.test(id)) return answer(400, 'Invalid alert id');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return answer(503, 'Monitoring alerts are unavailable');
    const found = await alertForAdmin(admin, guard.userId, id);
    if (!found.ok) return found.reason === 'not_found' ? answer(404, 'Alert not found') : answer(503, 'Monitoring alerts are unavailable');

    const changed = await setAlertStatus(admin, found.alert.id, ACTIONS[action], guard.userId);
    if (!changed) return answer(409, 'Alert state changed');

    const after = await alertForAdmin(admin, guard.userId, found.alert.id);
    if (!after.ok) return answer(503, 'Monitoring alerts are unavailable');
    console.log('[Monitor] alert status changed', { id: after.alert.id, status: after.alert.status });
    return NextResponse.json({ alert: after.alert }, { headers: NO_STORE });
  } catch {
    console.error('[Monitor] alert status change failed', { action });
    return answer(503, 'Monitoring alerts are unavailable');
  }
}
