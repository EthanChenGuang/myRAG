import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin, requireAdminOrDeny } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import {
  readTenantFeedbackSettings,
  setTenantFeedbackSettings,
  TENANT_RETRIEVAL_LOG_LEVELS,
  type TenantRetrievalLog,
} from '@/lib/rag/feedback-loop/settings';
import { parseTenantKey } from '@/lib/rag/tenant/embed';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store' };

const PutSchema = z
  .object({
    tenantKey: z.string().max(64),
    retrievalLog: z.enum(TENANT_RETRIEVAL_LOG_LEVELS as unknown as [TenantRetrievalLog, ...TenantRetrievalLog[]]),
  })
  .strict();

function invalid(details: Array<{ path: string; message: string }>): NextResponse {
  return NextResponse.json({ success: false, error: 'Invalid request data', details }, { status: 400, headers: NO_STORE });
}

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Tenant feedback settings are unavailable' }, { status: 503, headers: NO_STORE });
}

/** The canonical key for this deployment mode, or null: single-tenant knows only s:default, multi-tenant only o:/u: keys. */
function canonicalTenantKey(raw: unknown): string | null {
  const parsed = parseTenantKey(raw);
  if (!parsed) return null;
  const multi = getDeploymentMode() === 'multi-tenant';
  if (parsed.kind === 'single') return multi ? null : 's:default';
  if (!multi) return null;
  return parsed.kind === 'org' ? `o:${parsed.organizationId}` : `u:${parsed.userId}`;
}

const TENANT_KEY_DETAIL = { path: 'tenantKey', message: 'a tenant key of this deployment: s:default, or o:<uuid> / u:<uuid> in multi-tenant mode' };

/** D-06: an operator admin reads one tenant's retrieval-log setting. requireAdminOrDeny runs before anything is read. */
export async function GET(request: Request): Promise<Response> {
  const denied = await requireAdminOrDeny(request);
  if (denied) return denied;

  const tenantKey = canonicalTenantKey(new URL(request.url).searchParams.get('tenantKey'));
  if (!tenantKey) return invalid([TENANT_KEY_DETAIL]);

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const row = await readTenantFeedbackSettings(admin, tenantKey);
    return NextResponse.json(
      { success: true, settings: row ?? { tenant_key: tenantKey, retrieval_log: 'inherit', updated_by: null, updated_at: null } },
      { headers: NO_STORE },
    );
  } catch {
    console.error('[Feedback Loop] tenant setting read failed');
    return unavailable();
  }
}

/**
 * D-06: an operator admin lowers or restores one tenant's retrieval-log level (inherit, off, ids). The admin guard (checkAdmin/adminDenied,
 * the two halves of requireAdminOrDeny) runs first; its verified admin id is stored as updated_by.
 */
export async function PUT(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalid([{ path: '', message: 'the body must be JSON' }]);
  }
  const parsed = PutSchema.safeParse(body);
  if (!parsed.success) {
    return invalid(parsed.error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })));
  }
  const tenantKey = canonicalTenantKey(parsed.data.tenantKey);
  if (!tenantKey) return invalid([TENANT_KEY_DETAIL]);

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const settings = await setTenantFeedbackSettings(admin, { tenantKey, retrievalLog: parsed.data.retrievalLog, updatedBy: guard.userId });
    console.log('[Feedback Loop] tenant log setting changed', { retrievalLog: settings.retrieval_log });
    return NextResponse.json({ success: true, settings }, { headers: NO_STORE });
  } catch {
    console.error('[Feedback Loop] tenant setting write failed');
    return unavailable();
  }
}
