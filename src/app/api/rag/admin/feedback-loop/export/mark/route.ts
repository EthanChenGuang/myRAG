import { NextResponse } from 'next/server';
import { requireAdminOrDeny } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { markExported, MarkExportedRequestSchema, readFeedbackLoopConfig, validateGrantTenantKey } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

function badRequest(error: string): NextResponse {
  return NextResponse.json({ success: false, error }, { status: 400, headers: NO_STORE });
}

/**
 * D-20 and D-21: after the Python promotion, an operator admin records which of one tenant's items were exported and, for golden
 * items, their frozen split and split_group. requireAdminOrDeny runs first; 404 unless RAG_DOMAIN_EXPERT_REVIEW is true. Items of
 * another tenant are ignored and listed; a change to a frozen split is refused by the trigger and answered 409 for that item.
 */
export async function POST(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  if (!readFeedbackLoopConfig().domainExpertReview) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404, headers: NO_STORE });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return badRequest('The body must be JSON');
  }
  const parsed = MarkExportedRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return badRequest('tenant and 1 to 500 unique items {id, split?, split_group?} are required; split is dev or test and needs split_group');
  }
  const tenant = validateGrantTenantKey(parsed.data.tenant, getDeploymentMode());
  if (!tenant.ok) return badRequest('tenant is not a tenant key of this deployment mode');

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return NextResponse.json({ success: false, error: 'Export is unavailable' }, { status: 503, headers: NO_STORE });
    const result = await markExported(admin, tenant.tenantKey, parsed.data.items);
    const status = result.conflicts.length > 0 ? 409 : 200;
    return NextResponse.json({ success: status === 200, ...result }, { status, headers: NO_STORE });
  } catch (error) {
    console.error('[Feedback Loop] export mark failed', { code: error instanceof Error ? error.message : 'unknown' });
    return NextResponse.json({ success: false, error: 'Export is unavailable' }, { status: 503, headers: NO_STORE });
  }
}
