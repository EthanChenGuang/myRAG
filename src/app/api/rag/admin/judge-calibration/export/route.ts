import { NextResponse } from 'next/server';
import { z } from 'zod/v3';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { exportCalibrationCases, validateGrantTenantKey } from '@/lib/rag';
import { getSupabaseAdmin } from '@/lib/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'no-store' };

const ExportQuery = z.object({ tenant: z.string().min(1).max(64) }).strict();

function unavailable(): NextResponse {
  return NextResponse.json({ success: false, error: 'Calibration export is unavailable' }, { status: 503, headers: NO_STORE });
}

/**
 * D-31: one tenant's expert-labelled answer checks with their question, answer and context text re-read under that tenant, for the
 * judge calibration tool (admin Bearer). The admin guard runs first; the tenant must be a tenant key of this deployment mode and one the
 * admin administers (resolved in SQL). The body is never cached and its text is never logged.
 */
export async function GET(request: Request): Promise<Response> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return adminDenied(guard.status);

  const params = Object.fromEntries(new URL(request.url).searchParams.entries());
  const parsed = ExportQuery.safeParse(params);
  const tenant = parsed.success ? validateGrantTenantKey(parsed.data.tenant, getDeploymentMode()) : null;
  if (!tenant || !tenant.ok) {
    return NextResponse.json(
      { success: false, error: 'tenant is required, must be a tenant key of this deployment mode, and no other parameter is accepted' },
      { status: 400, headers: NO_STORE },
    );
  }

  try {
    const admin = getSupabaseAdmin();
    if (!admin) return unavailable();
    const result = await exportCalibrationCases(admin, { actorUserId: guard.userId, tenantKey: tenant.tenantKey });
    if (!result.ok) {
      if (result.reason === 'forbidden_tenant') {
        return NextResponse.json({ success: false, error: 'Tenant not administered by this admin' }, { status: 403, headers: NO_STORE });
      }
      if (result.reason === 'invalid_tenant') {
        return NextResponse.json({ success: false, error: 'Invalid tenant key' }, { status: 400, headers: NO_STORE });
      }
      return unavailable();
    }
    return NextResponse.json({ success: true, ...result.export }, { headers: NO_STORE });
  } catch (error) {
    console.error('[RAG Admin] judge calibration export failed', { code: error instanceof Error ? error.message : 'unknown' });
    return unavailable();
  }
}
