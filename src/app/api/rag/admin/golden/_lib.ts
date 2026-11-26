import { NextResponse } from 'next/server';
import type { z } from 'zod/v3';
import type { SupabaseClient } from '@supabase/supabase-js';
import { adminDenied, checkAdmin } from '@/lib/admin-route-auth';
import { adminTenantKeys } from '@/lib/rag/config-gate/eval-run-requests';
import { validateGrantTenantKey } from '@/lib/rag/feedback-loop/review-access';
import { getDeploymentMode } from '@/lib/deployment-mode';
import { getSupabaseAdmin } from '@/lib/supabase';

const NO_STORE = { 'Cache-Control': 'no-store' };

export function jsonNoStore(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

export function fail(status: number, error: string): NextResponse {
  return jsonNoStore({ success: false, error }, status);
}

export function invalid(error: z.ZodError): NextResponse {
  return jsonNoStore(
    { success: false, error: 'Invalid request data', details: error.errors.map((issue) => ({ path: issue.path.join('.'), message: issue.message })) },
    400,
  );
}

export const unavailable = (): NextResponse => fail(503, 'Golden evidence is unavailable');

export type GoldenAccess = { ok: true; admin: SupabaseClient; tenantKey: string } | { ok: false; response: NextResponse };

/**
 * D-55: the admin guard runs first (401/403/503); then the tenant must be a key of this deployment mode (400) and one the admin
 * administers, resolved in SQL by rag_admin_tenant_keys (403). Nothing is read before both checks pass.
 */
export async function goldenGuard(request: Request): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const guard = await checkAdmin(request);
  if (!guard.ok) return { ok: false, response: adminDenied(guard.status) };
  return { ok: true, userId: guard.userId };
}

export async function tenantAccess(userId: string, tenant: string): Promise<GoldenAccess> {
  const validated = validateGrantTenantKey(tenant, getDeploymentMode());
  if (!validated.ok) return { ok: false, response: fail(400, 'tenant must be a tenant key of this deployment mode') };
  const admin = getSupabaseAdmin();
  if (!admin) return { ok: false, response: unavailable() };
  const keys = await adminTenantKeys(admin, userId);
  if (keys === null) return { ok: false, response: unavailable() };
  if (!keys.includes(validated.tenantKey)) return { ok: false, response: fail(403, 'Tenant not administered by this admin') };
  return { ok: true, admin, tenantKey: validated.tenantKey };
}

export async function readJson(request: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await request.json() };
  } catch {
    return { ok: false };
  }
}
