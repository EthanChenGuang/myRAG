import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { buildExport, EXPORT_KINDS, readFeedbackLoopConfig, validateGrantTenantKey } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const ExportQuery = z.object({ kind: z.enum(EXPORT_KINDS), tenant: z.string().min(1).max(64) }).strict();

function badRequest(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400, headers: NO_STORE });
}

/**
 * D-17 and D-20: an operator admin pulls one tenant's labelled items of one triage kind as NDJSON (DictionaryCandidate, TrainingPair
 * or GoldenExportLine per line). requireAdminOrDeny runs before anything else; 404 unless RAG_DOMAIN_EXPERT_REVIEW is true; the
 * tenant key must be valid for the deployment mode. Reads use the service-role client filtered by that tenant_key.
 */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  if (!readFeedbackLoopConfig().domainExpertReview) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
  }

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = ExportQuery.safeParse(params);
  if (!parsed.success) return badRequest('kind must be dictionary, training or golden, tenant is required, and no other parameter is accepted');
  const tenant = validateGrantTenantKey(parsed.data.tenant, getDeploymentMode());
  if (!tenant.ok) return badRequest('tenant is not a tenant key of this deployment mode');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return NextResponse.json({ success: false, error: 'Export is unavailable' }, { status: 503, headers: NO_STORE });
    const lines = await buildExport(admin, parsed.data.kind, tenant.tenantKey);
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        controller.close();
      },
    });
    return new Response(body, {
      status: 200,
      headers: { ...NO_STORE, 'Content-Type': 'application/x-ndjson; charset=utf-8', 'X-Export-Count': String(lines.length) },
    });
  } catch (error) {
    console.error('[Feedback Loop] export failed', { kind: parsed.data.kind, code: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ success: false, error: 'Export is unavailable' }, { status: 503, headers: NO_STORE });
  }
}
