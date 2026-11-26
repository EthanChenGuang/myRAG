import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { listAlerts, MAX_ALERTS_PAGE, monitorSummary } from '@/lib/rag/monitor/alerts-read';
import { monitorSettings } from '@/lib/rag/monitor/config';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };
const TENANT_KEY_RE = /^(s:default|[uo]:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

const QuerySchema = z.object({
  status: z.enum(['open', 'acknowledged', 'resolved', 'active', 'all']).default('active'),
  tenant: z.string().regex(TENANT_KEY_RE).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_ALERTS_PAGE).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

function notFound(): NextResponse {
  return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
}

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Monitoring alerts are unavailable' }, { status: 503, headers: NO_STORE });
}

function invalid(details: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json({ success: false, error: 'Invalid request data', details }, { status: 400, headers: NO_STORE });
}

/**
 * D-22, D-25, UI-SPEC 6.6, 6.7 and 8.1: the monitor summary, open and acknowledged counts and one page of alerts of the tenants
 * the verified admin administers. 404 while RAG_MONITOR is off, before the admin check, so nothing is read.
 */
export async function GET(request: Request): Promise<Response> {
  if (!monitorSettings().monitor) return notFound();
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const params = new URL(request.url).searchParams;
  const parsed = QuerySchema.safeParse({
    status: params.get('status') ?? undefined,
    tenant: params.get('tenant') ?? undefined,
    limit: params.get('limit') ?? undefined,
    cursor: params.get('cursor') ?? undefined,
  });
  if (!parsed.success) {
    return invalid(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const list = await listAlerts(admin, {
      actorUserId: guard.userId,
      status: parsed.data.status,
      tenant: parsed.data.tenant ?? null,
      limit: parsed.data.limit,
      cursor: parsed.data.cursor ?? null,
    });
    if (!list.ok) {
      if (list.reason === 'invalid_cursor') return invalid([{ path: 'cursor', message: 'Invalid cursor' }]);
      return unavailable();
    }
    const summary = await monitorSummary(admin);
    if (!summary.ok) return unavailable();
    console.log('[Monitor] alerts listed', { count: list.alerts.length, invalid: list.invalid, open: list.counts.open });
    return NextResponse.json(
      { monitor: summary.monitor, counts: list.counts, alerts: list.alerts, next_cursor: list.nextCursor },
      { headers: NO_STORE },
    );
  } catch {
    console.error('[Monitor] alerts read failed');
    return unavailable();
  }
}
