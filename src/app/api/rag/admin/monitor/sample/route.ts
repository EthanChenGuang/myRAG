import { drawWeeklySample, monitorSettings, sampleStatus } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';
import { admit, jsonNoStore, notFoundUnless } from '../../_tenant-data/lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function unavailable() {
  return jsonNoStore({ success: false, error: 'The weekly sample is unavailable' }, 503);
}

function failed(error: unknown) {
  const operation = (error as { operation?: unknown } | null)?.operation;
  console.error('[Monitor] sample route failed', { operation: typeof operation === 'string' ? operation : 'unknown' });
  return unavailable();
}

/**
 * D-39, UI-SPEC 6.10.1 and 8.1: the weekly sample status of the admin's workspace, counts and dates only. 404 while
 * RAG_REPRESENTATIVE_SAMPLE is off, checked before the admin guard so nothing is queried; the tenant comes from organizationId
 * through the server-side admission only.
 */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(monitorSettings().representativeSample);
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  try {
    return jsonNoStore({ success: true, ...(await sampleStatus(admin, admitted.tenantKey)) });
  } catch (error) {
    return failed(error);
  }
}

/** Draws the workspace's sample of the last ISO week now (a rerun only tops the week up), then returns the status with the run counts. */
export async function POST(request: Request): Promise<Response> {
  const off = notFoundUnless(monitorSettings().representativeSample);
  if (off) return off;
  const admitted = await admit(request);
  if (!admitted.ok) return admitted.response;
  const admin = getSupabaseAdmin();
  if (!admin) return unavailable();
  try {
    const result = await drawWeeklySample(admin, { tenantKey: admitted.tenantKey, signal: request.signal });
    const run = result.written
      ? { written: true, week: result.week, added: result.added, excluded_queued: result.excluded_queued, missing: [] }
      : { written: false, week: null, added: 0, excluded_queued: 0, missing: result.missing };
    console.log('[Monitor] sample route run', { written: run.written, added: run.added });
    return jsonNoStore({ success: true, ...(await sampleStatus(admin, admitted.tenantKey)), run });
  } catch (error) {
    return failed(error);
  }
}
