import { z } from 'zod/v3';
import { latestDrift, loadMonitorAlertsConfig, monitorSettings, storeDriftReport } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { admit, invalidRequest, issues, jsonBody, jsonNoStore, notFoundUnless } from '../../_tenant-data/lib';
import { admitTenant, guardAdmin, monitorUnavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BodySchema = z.object({ tenant: z.string().min(1).max(64), report: z.unknown() }).strict();

function failed(method: string, error: unknown): Response {
  const operation = (error as { operation?: unknown } | null)?.operation;
  console.error('[Monitor] drift route failed', { method, operation: typeof operation === 'string' ? operation : 'unknown' });
  return monitorUnavailable();
}

/**
 * D-44, D-45: python -m rag_eval.drift posts one tenant's weekly DriftReport (admin Bearer; the tenant must be one the admin
 * administers). The report's state, cluster states, gap verdicts and limits are recomputed from its numbers and
 * eval/config/monitor-alerts.json; it is stored per tenant and week, and with RAG_MONITOR on the drift alerts are raised.
 * 404 while RAG_REPRESENTATIVE_SAMPLE is off, checked before the guard.
 */
export async function POST(request: Request): Promise<Response> {
  const settings = monitorSettings();
  const off = notFoundUnless(settings.representativeSample);
  if (off) return off;
  const guard = await guardAdmin(request);
  if (!guard.ok) return guard.response;
  const body = await jsonBody(request);
  if (!body.ok) return body.response;
  const parsed = BodySchema.safeParse(body.body);
  if (!parsed.success || parsed.data.report === undefined) {
    return invalidRequest(parsed.success ? [{ path: 'report', message: 'Required' }] : issues(parsed.error));
  }
  const config = loadMonitorAlertsConfig();
  if (!config) return monitorUnavailable();
  try {
    const admitted = await admitTenant(guard.userId, parsed.data.tenant);
    if (!admitted.ok) return admitted.response;
    const result = await storeDriftReport(admitted.admin, {
      tenantKey: admitted.tenantKey,
      report: parsed.data.report,
      config,
      monitorOn: settings.monitor,
      channels: settings.webhookUrl ? ['webhook'] : [],
    });
    if (!result.ok) return invalidRequest(result.details);
    return jsonNoStore({ success: true, week: result.week, state: result.state, inserted: result.inserted, alerts: result.alerts });
  } catch (error) {
    return failed('POST', error);
  }
}

/**
 * UI-SPEC 6.8 and 8.1: the Test set coverage view of the admin's workspace (latest week, 8-week trend, cluster rows, limits and the
 * optional scores, gaps and rates). The tenant comes from organizationId through the server-side admission only.
 */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(monitorSettings().representativeSample);
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const admin = getSupabaseAdmin();
  const config = loadMonitorAlertsConfig();
  if (!admin || !config) return monitorUnavailable();
  try {
    return jsonNoStore({ success: true, ...(await latestDrift(admin, admitted.tenantKey, config)) });
  } catch (error) {
    return failed('GET', error);
  }
}
