import { z } from 'zod/v3';
import { driftInputs, monitorSettings } from '@/lib/rag';
import { invalidRequest, issues, jsonNoStore, notFoundUnless } from '../../_tenant-data/lib';
import { admitTenant, guardAdmin, monitorUnavailable } from '../_lib';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const QuerySchema = z.object({ tenant: z.string().min(1).max(64) }).strict();

/**
 * D-43: production cluster shares of the last 30 days (with novel), online judge means and vote and refusal rates per slice for
 * python -m rag_eval.drift, as counts and rates only. 404 while RAG_REPRESENTATIVE_SAMPLE is off, before the admin Bearer guard;
 * the tenant must be one the admin administers.
 */
export async function GET(request: Request): Promise<Response> {
  const off = notFoundUnless(monitorSettings().representativeSample);
  if (off) return off;
  const guard = await guardAdmin(request);
  if (!guard.ok) return guard.response;
  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams.entries()));
  if (!parsed.success) return invalidRequest(issues(parsed.error));
  try {
    const admitted = await admitTenant(guard.userId, parsed.data.tenant);
    if (!admitted.ok) return admitted.response;
    return jsonNoStore({ success: true, ...(await driftInputs(admitted.admin, { tenantKey: admitted.tenantKey })) });
  } catch (error) {
    const operation = (error as { operation?: unknown } | null)?.operation;
    console.error('[Monitor] drift-inputs route failed', { operation: typeof operation === 'string' ? operation : 'unknown' });
    return monitorUnavailable();
  }
}
